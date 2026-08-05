import { expect, test } from '@playwright/test';
import {
	DB_PROJECT,
	dbAdminCollectionPath,
	dbAdminTablePath,
	dbDocumentPath,
	dbDocumentsPath,
	dbRowPath,
	dbRowsPath
} from './helpers';

/**
 * The R1 replication substrate through the built web worker: session
 * bookmarks (cfb-lsn / cfb-min-lsn ride the proxy untouched), region-routed
 * reads served by replicas (pinned via the env.test x-cfb-region override on
 * this single-colo stack), the replica registry, and the disable path.
 * Shard names carry a per-run suffix; the replication flag itself is per
 * shard, so nothing here touches the other specs' shards.
 */

const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

function replicationStatusPath(name: string): string {
	return `/api/projects/${DB_PROJECT}/db/admin/replication/${encodeURIComponent(name)}`;
}

interface RepStatusBody {
	enabled: boolean;
	lastLsn: number;
	replicas: { id: string; region: string; appliedLsn: number; lagLsn: number }[];
}

test.describe('db agent (replication)', () => {
	test('replicated collections serve region reads with session bookmarks', async ({ request }) => {
		const collection = `rep-${run}`;
		const provision = await request.put(dbAdminCollectionPath(DB_PROJECT, collection), {
			data: { readAccess: 'public', writeAccess: 'public', replication: 'auto' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		// Writes on a replicated primary answer with the session bookmark.
		const first = await request.post(dbDocumentsPath(DB_PROJECT, collection), {
			data: { id: 'n1', data: { title: 'first' } }
		});
		expect(first.status(), await first.text()).toBe(201);
		expect(Number(first.headers()['cfb-lsn'])).toBeGreaterThan(0);

		// A region-pinned read bootstraps the weur replica and serves from it.
		const routed = await request.get(dbDocumentPath(DB_PROJECT, collection, 'n1'), {
			headers: { 'x-cfb-region': 'weur' }
		});
		expect(routed.ok(), await routed.text()).toBeTruthy();
		expect((await routed.json()).data.title).toBe('first');

		// The replica registered itself during bootstrap - BEFORE any pull -
		// which is what makes the erase fan-out complete.
		const registered = (await (
			await request.get(replicationStatusPath(collection))
		).json()) as RepStatusBody;
		expect(registered.enabled).toBe(true);
		expect(registered.replicas.map((replica) => replica.id)).toContain('r:weur:1');

		// Read-your-writes: a fresh write's bookmark forces the replica to
		// catch up (or hand over) before answering.
		const second = await request.post(dbDocumentsPath(DB_PROJECT, collection), {
			data: { id: 'n2', data: { title: 'second' } }
		});
		expect(second.status(), await second.text()).toBe(201);
		const lsn = Number(second.headers()['cfb-lsn']);
		expect(lsn).toBeGreaterThan(0);

		const bookmarked = await request.get(dbDocumentPath(DB_PROJECT, collection, 'n2'), {
			headers: { 'x-cfb-region': 'weur', 'cfb-min-lsn': String(lsn) }
		});
		expect(bookmarked.ok(), await bookmarked.text()).toBeTruthy();
		expect((await bookmarked.json()).data.title).toBe('second');

		// And the replica really did apply it locally.
		const caughtUp = (await (
			await request.get(replicationStatusPath(collection))
		).json()) as RepStatusBody;
		const weur = caughtUp.replicas.find((replica) => replica.id === 'r:weur:1');
		expect(weur, JSON.stringify(caughtUp)).toBeTruthy();
		expect(weur!.appliedLsn).toBeGreaterThanOrEqual(lsn);
	});

	test('replicated tables mirror the collection flow', async ({ request }) => {
		const table = `rept-${run}`;
		const declare = await request.put(dbAdminTablePath(DB_PROJECT, table), {
			data: {
				readAccess: 'public',
				writeAccess: 'public',
				replication: 'auto',
				columns: [{ name: 'title', type: 'text', nullable: false }]
			}
		});
		expect(declare.ok(), await declare.text()).toBeTruthy();

		const created = await request.post(dbRowsPath(DB_PROJECT, table), {
			data: { id: 't1', data: { title: 'replicated row' } }
		});
		expect(created.status(), await created.text()).toBe(201);
		const lsn = Number(created.headers()['cfb-lsn']);
		expect(lsn).toBeGreaterThan(0);

		const routed = await request.get(dbRowPath(DB_PROJECT, table, 't1'), {
			headers: { 'x-cfb-region': 'apac', 'cfb-min-lsn': String(lsn) }
		});
		expect(routed.ok(), await routed.text()).toBeTruthy();
		expect((await routed.json()).data.title).toBe('replicated row');

		const status = (await (
			await request.get(replicationStatusPath(table))
		).json()) as RepStatusBody;
		expect(status.enabled).toBe(true);
		expect(status.replicas.map((replica) => replica.id)).toContain('r:apac:1');
	});

	test('disabling replication destroys replicas and keeps reads working', async ({ request }) => {
		const collection = `repoff-${run}`;
		const enable = await request.put(dbAdminCollectionPath(DB_PROJECT, collection), {
			data: { readAccess: 'public', writeAccess: 'public', replication: 'auto' }
		});
		expect(enable.ok(), await enable.text()).toBeTruthy();

		const created = await request.post(dbDocumentsPath(DB_PROJECT, collection), {
			data: { id: 'keep', data: { title: 'survives' } }
		});
		expect(created.status(), await created.text()).toBe(201);

		// Materialize a replica, then turn replication off.
		const warm = await request.get(dbDocumentPath(DB_PROJECT, collection, 'keep'), {
			headers: { 'x-cfb-region': 'weur' }
		});
		expect(warm.ok()).toBeTruthy();

		const disable = await request.put(dbAdminCollectionPath(DB_PROJECT, collection), {
			data: { readAccess: 'public', writeAccess: 'public', replication: 'off' }
		});
		expect(disable.ok(), await disable.text()).toBeTruthy();

		const status = (await (
			await request.get(replicationStatusPath(collection))
		).json()) as RepStatusBody;
		expect(status.enabled).toBe(false);
		expect(status.replicas).toEqual([]);

		// A region-pinned read during the worker's stale routing-cache window
		// still answers: the (destroyed) replica cannot serve, so the request
		// lands on the primary - the forward net, not an error.
		const after = await request.get(dbDocumentPath(DB_PROJECT, collection, 'keep'), {
			headers: { 'x-cfb-region': 'weur' }
		});
		expect(after.ok(), await after.text()).toBeTruthy();
		expect((await after.json()).data.title).toBe('survives');
	});

	test('unreplicated shards never advertise bookmarks', async ({ request }) => {
		const collection = `repnone-${run}`;
		const provision = await request.put(dbAdminCollectionPath(DB_PROJECT, collection), {
			data: { readAccess: 'public', writeAccess: 'public' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		const created = await request.post(dbDocumentsPath(DB_PROJECT, collection), {
			data: { data: { title: 'plain' } }
		});
		expect(created.status(), await created.text()).toBe(201);
		expect(created.headers()['cfb-lsn']).toBeUndefined();

		const status = (await (
			await request.get(replicationStatusPath(collection))
		).json()) as RepStatusBody;
		expect(status.enabled).toBe(false);
	});
});
