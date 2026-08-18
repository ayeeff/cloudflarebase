import {
	expect,
	request as playwrightRequest,
	test,
	type APIRequestContext
} from '@playwright/test';
import {
	authPath,
	DB_PROJECT,
	dbAdminCollectionPath,
	dbAdminTablePath,
	dbDocumentPath,
	dbDocumentsPath,
	dbRowPath,
	dbRowsPath,
	uniqueEmail
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

function sqlPath(table: string): string {
	return `/api/projects/${DB_PROJECT}/db/tables/${table}/sql`;
}

async function anonymousContext(baseURL: string | undefined): Promise<APIRequestContext> {
	const base = baseURL ?? process.env.BASE_URL ?? 'http://localhost:8797';
	return playwrightRequest.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
}

/** Sign up a fresh user on the db project and exchange for a project JWT. */
async function projectUserToken(baseURL: string | undefined, prefix: string): Promise<string> {
	const anon = await anonymousContext(baseURL);
	try {
		const signUp = await anon.post(authPath(DB_PROJECT, 'sign-up/email'), {
			data: {
				name: 'Rollback Spec User',
				email: uniqueEmail(prefix),
				password: 'db-spec-password-1'
			}
		});
		expect(signUp.ok(), await signUp.text()).toBeTruthy();
		const sessionToken = signUp.headers()['set-auth-token'];
		const token = await anon.get(authPath(DB_PROJECT, 'token'), {
			headers: { authorization: `Bearer ${sessionToken}` }
		});
		expect(token.ok(), await token.text()).toBeTruthy();
		return (await token.json()).token as string;
	} finally {
		await anon.dispose();
	}
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

	// A failing batch rolls back on the primary - and NOTHING about it may
	// escape to replicas. The push used to be scheduled from inside the
	// transaction, so replicas applied phantom rows; worse, sqlite_sequence
	// rolls back too, so the next committed write REUSED the phantom's LSN
	// and the replica dropped it as a duplicate - permanent divergence that
	// defeated the cfb-min-lsn bookmark (the replica believed it was caught
	// up). The old atomicity spec ran replication: off, which is why none of
	// this was ever pinned.
	test('a rolled-back batch statement never reaches replica subscribers', async ({
		request,
		baseURL
	}) => {
		const table = `rollb-${run}`;
		const declare = await request.put(dbAdminTablePath(DB_PROJECT, table), {
			data: {
				readAccess: 'public',
				writeAccess: 'public',
				replication: 'auto',
				columns: [{ name: 'title', type: 'text', nullable: false }]
			}
		});
		expect(declare.ok(), await declare.text()).toBeTruthy();

		const token = await projectUserToken(baseURL, 'sql-rollback');
		const anon = await anonymousContext(baseURL);
		const asUser = { authorization: `Bearer ${token}` };
		const socket = await LiveSocket.connect(replicaSubscribeUrl('tables', table, 'weur'));
		try {
			socket.send({ type: 'subscribe', id: 'w', query: {} });
			const snapshot = await socket.next((frame) => frame.type === 'snapshot', 'the snapshot');
			expect(snapshot.docs).toEqual([]);

			await expect
				.poll(async () => {
					const status = (await (await request.get(replicationStatusPath(table))).json()) as {
						replicas: { id: string; push: boolean }[];
					};
					return status.replicas.find((replica) => replica.id === 'r:weur:1')?.push ?? false;
				})
				.toBe(true);

			// Prove the push chain delivers BEFORE asserting silence on it.
			const live = await anon.post(sqlPath(table), {
				headers: asUser,
				data: { sql: `INSERT INTO "${table}" (id, title) VALUES (?, ?)`, params: ['live', 'ok'] }
			});
			expect(live.ok(), await live.text()).toBeTruthy();
			expect(Number(live.headers()['cfb-lsn'])).toBeGreaterThan(0);
			await socket.next(
				(frame) => frame.type === 'change' && frame.kind === 'added' && frame.doc?.id === 'live',
				'the live-proof added frame'
			);

			// Statement 1 writes, statement 2 hits NOT NULL: rollback whole.
			const failing = await anon.post(sqlPath(table), {
				headers: asUser,
				data: {
					batch: [
						{ sql: `INSERT INTO "${table}" (id, title) VALUES (?, ?)`, params: ['ghost', 'boo'] },
						{ sql: `INSERT INTO "${table}" (id, title) VALUES (?, ?)`, params: ['g2', null] }
					]
				}
			});
			expect(failing.status(), await failing.text()).toBe(400);
			expect(failing.headers()['cfb-lsn']).toBeUndefined();

			// The rolled-back LSN must not linger as a later response's
			// bookmark: a SELECT never logs, so any header here is the leak.
			const selected = await anon.post(sqlPath(table), {
				headers: asUser,
				data: { sql: `SELECT "id" FROM "${table}"` }
			});
			expect(selected.ok(), await selected.text()).toBeTruthy();
			expect(selected.headers()['cfb-lsn']).toBeUndefined();

			// The next committed write reuses the rolled-back LSN. The replica
			// must apply it (not drop it as a duplicate) and push its frame.
			const reissued = await anon.post(sqlPath(table), {
				headers: asUser,
				data: { sql: `INSERT INTO "${table}" (id, title) VALUES (?, ?)`, params: ['after', 'real'] }
			});
			expect(reissued.ok(), await reissued.text()).toBeTruthy();
			const lsn = Number(reissued.headers()['cfb-lsn']);
			expect(lsn).toBeGreaterThan(0);
			await socket.next(
				(frame) => frame.type === 'change' && frame.kind === 'added' && frame.doc?.id === 'after',
				'the post-rollback added frame'
			);

			// No frame for the phantom ever arrived on the replica subscriber.
			expect(socket.peek((frame) => frame.doc?.id === 'ghost')).toBeUndefined();

			// Read-your-writes THROUGH the replica: the write's own bookmark
			// must find the row (a diverged replica claims the LSN is applied
			// and serves a local copy missing it)...
			const routed = await request.get(dbRowPath(DB_PROJECT, table, 'after'), {
				headers: { 'x-cfb-region': 'weur', 'cfb-min-lsn': String(lsn) }
			});
			expect(routed.ok(), await routed.text()).toBeTruthy();
			expect((await routed.json()).data.title).toBe('real');

			// ...and the phantom is absent on BOTH sides.
			for (const headers of [{}, { 'x-cfb-region': 'weur' }]) {
				const gone = await request.get(dbRowPath(DB_PROJECT, table, 'ghost'), { headers });
				expect(gone.status(), `ghost row with ${JSON.stringify(headers)}`).toBe(404);
			}
		} finally {
			socket.close();
			await anon.dispose();
		}
	});
});
