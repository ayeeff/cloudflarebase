import { expect, test } from '@playwright/test';
import {
	DB_PROJECT,
	dbAdminCollectionPath,
	dbAdminTablePath,
	dbDocumentPath,
	dbDocumentsPath,
	dbRowsPath
} from './helpers';
import { LiveSocket, WEB_WS } from './live-socket';

/**
 * REP2: live queries served BY REPLICAS. The subscriber's socket lands on the
 * region replica (?cfb-region - WebSocket clients cannot set headers, so the
 * env.test override rides a query param); writes hit the primary, whose RPC
 * push wakes the replica, which applies the entry and notifies its own
 * subscribers. The whole delivery chain - primary log -> push -> replica
 * apply -> local live engine - is what these frames prove.
 */

const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

function replicaSubscribeUrl(kind: 'collections' | 'tables', name: string, region: string): string {
	return `${WEB_WS}/agents/db-agent/${DB_PROJECT}/${kind}/${name}/subscribe?cfb-region=${region}`;
}

function replicationStatusPath(name: string): string {
	return `/api/projects/${DB_PROJECT}/db/admin/replication/${encodeURIComponent(name)}`;
}

test.describe('db agent (live queries on replicas)', () => {
	test.skip(!!process.env.BASE_URL, 'WebSocket endpoints are pinned on the local stack only');

	test('replica subscribers receive pushed deltas from primary writes', async ({ request }) => {
		const collection = `rlive-${run}`;
		const provision = await request.put(dbAdminCollectionPath(DB_PROJECT, collection), {
			data: { readAccess: 'public', writeAccess: 'public', replication: 'auto' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		const seeded = await request.post(dbDocumentsPath(DB_PROJECT, collection), {
			data: { id: 'seed', data: { kind: 'task', rank: 1 } }
		});
		expect(seeded.status(), await seeded.text()).toBe(201);

		const socket = await LiveSocket.connect(replicaSubscribeUrl('collections', collection, 'weur'));
		try {
			socket.send({
				type: 'subscribe',
				id: 's1',
				query: { where: [{ field: 'kind', op: '==', value: 'task' }] }
			});
			const snapshot = await socket.next((frame) => frame.type === 'snapshot', 'the snapshot');
			expect(snapshot.docs?.map((doc) => doc.id)).toEqual(['seed']);

			// The subscriber flipped the primary's push flag for this replica.
			await expect
				.poll(async () => {
					const status = (await (await request.get(replicationStatusPath(collection))).json()) as {
						replicas: { id: string; push: boolean }[];
					};
					return status.replicas.find((replica) => replica.id === 'r:weur:1')?.push ?? false;
				})
				.toBe(true);

			// A primary write becomes an added frame ON THE REPLICA.
			const created = await request.post(dbDocumentsPath(DB_PROJECT, collection), {
				data: { id: 'pushed', data: { kind: 'task', rank: 2 } }
			});
			expect(created.status(), await created.text()).toBe(201);
			const added = await socket.next(
				(frame) => frame.type === 'change' && frame.kind === 'added',
				'the pushed added frame'
			);
			expect(added.doc?.id).toBe('pushed');

			// PATCH -> modified; exit the predicate -> removed. Same chain.
			const kept = await request.patch(dbDocumentPath(DB_PROJECT, collection, 'pushed'), {
				data: { note: 'still a task' }
			});
			expect(kept.ok(), await kept.text()).toBeTruthy();
			const modified = await socket.next(
				(frame) => frame.type === 'change' && frame.kind === 'modified',
				'the pushed modified frame'
			);
			expect(modified.doc?.data.note).toBe('still a task');

			const exited = await request.patch(dbDocumentPath(DB_PROJECT, collection, 'pushed'), {
				data: { kind: 'archived' }
			});
			expect(exited.ok(), await exited.text()).toBeTruthy();
			const removed = await socket.next(
				(frame) => frame.type === 'change' && frame.kind === 'removed',
				'the pushed removed frame'
			);
			expect(removed.doc?.id).toBe('pushed');
		} finally {
			socket.close();
		}
	});

	test('replica subscribers on tables get typed deltas too', async ({ request }) => {
		const table = `rtlive-${run}`;
		const declare = await request.put(dbAdminTablePath(DB_PROJECT, table), {
			data: {
				readAccess: 'public',
				writeAccess: 'public',
				replication: 'auto',
				columns: [
					{ name: 'title', type: 'text', nullable: false },
					{ name: 'rank', type: 'integer', default: 0 }
				]
			}
		});
		expect(declare.ok(), await declare.text()).toBeTruthy();

		const socket = await LiveSocket.connect(replicaSubscribeUrl('tables', table, 'apac'));
		try {
			socket.send({
				type: 'subscribe',
				id: 'w',
				query: { orderBy: [{ field: 'rank', direction: 'asc' }], limit: 2 }
			});
			const snapshot = await socket.next((frame) => frame.type === 'snapshot', 'the snapshot');
			expect(snapshot.docs).toEqual([]);

			for (const [id, rank] of [
				['r10', 10],
				['r20', 20]
			] as const) {
				const created = await request.post(dbRowsPath(DB_PROJECT, table), {
					data: { id, data: { title: id, rank } }
				});
				expect(created.status(), await created.text()).toBe(201);
				const added = await socket.next(
					(frame) => frame.type === 'change' && frame.kind === 'added' && frame.doc?.id === id,
					`the pushed added frame for ${id}`
				);
				expect(added.doc?.data.rank).toBe(rank);
			}

			// Windowed displacement across the push chain: rank 15 enters the
			// window, rank 20 leaves it.
			const wedge = await request.post(dbRowsPath(DB_PROJECT, table), {
				data: { id: 'r15', data: { title: 'r15', rank: 15 } }
			});
			expect(wedge.status(), await wedge.text()).toBe(201);
			const added = await socket.next(
				(frame) => frame.type === 'change' && frame.kind === 'added' && frame.doc?.id === 'r15',
				'the incoming window frame'
			);
			expect(added.doc?.id).toBe('r15');
			const removed = await socket.next(
				(frame) => frame.type === 'change' && frame.kind === 'removed',
				'the displaced window frame'
			);
			expect(removed.doc?.id).toBe('r20');
		} finally {
			socket.close();
		}
	});
});
