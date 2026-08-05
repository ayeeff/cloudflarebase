import { expect, test } from '@playwright/test';
import { DB_PROJECT, dbAdminTablePath, dbRowPath, dbRowsPath } from './helpers';
import { AGENT_WS, LiveSocket, WEB_WS } from './live-socket';

/**
 * Live queries over SQL tables: the same frame protocol as collections
 * (shared engine by construction), but compiled against declared typed
 * columns - including the table-only refusal of subscribe queries over
 * undeclared columns. Local stack only, like the collections live spec.
 */

const run = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

function subscribeUrl(base: string, table: string): string {
	return `${base}/agents/db-agent/${DB_PROJECT}/tables/${table}/subscribe`;
}

test.describe('db agent (live queries over tables)', () => {
	test.skip(!!process.env.BASE_URL, 'WebSocket endpoints are pinned on the local stack only');

	test('streams snapshot and deltas over typed columns', async ({ request }) => {
		const table = `tlive-${run}`;
		const declare = await request.put(dbAdminTablePath(DB_PROJECT, table), {
			data: {
				readAccess: 'public',
				writeAccess: 'public',
				columns: [
					{ name: 'title', type: 'text', nullable: false },
					{ name: 'rank', type: 'integer', default: 0 },
					{ name: 'done', type: 'boolean', default: false }
				]
			}
		});
		expect(declare.ok(), await declare.text()).toBeTruthy();

		// Seeded out of rank order: the snapshot must come back in query order.
		for (const [id, rank] of [
			['t-second', 2],
			['t-first', 1]
		] as const) {
			const created = await request.post(dbRowsPath(DB_PROJECT, table), {
				data: { id, data: { title: id, rank } }
			});
			expect(created.status(), await created.text()).toBe(201);
		}

		const socket = await LiveSocket.connect(subscribeUrl(WEB_WS, table));
		try {
			socket.send({
				type: 'subscribe',
				id: 's1',
				query: {
					where: [{ field: 'done', op: '==', value: false }],
					orderBy: [{ field: 'rank', direction: 'asc' }]
				}
			});
			const snapshot = await socket.next((frame) => frame.type === 'snapshot', 'the snapshot');
			expect(snapshot.docs?.map((doc) => doc.id)).toEqual(['t-first', 't-second']);
			// Rows arrive in the document envelope with typed values.
			expect(snapshot.docs?.[0].data).toEqual({ title: 't-first', rank: 1, done: false });

			// An insert matching the predicate -> added.
			const created = await request.post(dbRowsPath(DB_PROJECT, table), {
				data: { id: 't-third', data: { title: 't-third', rank: 3 } }
			});
			expect(created.status(), await created.text()).toBe(201);
			const added = await socket.next(
				(frame) => frame.type === 'change' && frame.kind === 'added',
				'the added frame'
			);
			expect(added.doc?.id).toBe('t-third');

			// A PATCH flipping the boolean exits the predicate -> removed.
			const flipped = await request.patch(dbRowPath(DB_PROJECT, table, 't-third'), {
				data: { done: true }
			});
			expect(flipped.ok(), await flipped.text()).toBeTruthy();
			const removed = await socket.next(
				(frame) => frame.type === 'change' && frame.kind === 'removed',
				'the removed frame'
			);
			expect(removed.doc?.id).toBe('t-third');
		} finally {
			socket.close();
		}
	});

	test('windowed table queries emit displacement deltas', async ({ request }) => {
		const table = `twin-${run}`;
		const declare = await request.put(dbAdminTablePath(DB_PROJECT, table), {
			data: {
				readAccess: 'public',
				writeAccess: 'public',
				columns: [{ name: 'rank', type: 'integer', nullable: false }]
			}
		});
		expect(declare.ok(), await declare.text()).toBeTruthy();

		for (const [id, rank] of [
			['w10', 10],
			['w20', 20],
			['w30', 30]
		] as const) {
			const created = await request.post(dbRowsPath(DB_PROJECT, table), {
				data: { id, data: { rank } }
			});
			expect(created.status(), await created.text()).toBe(201);
		}

		const socket = await LiveSocket.connect(subscribeUrl(WEB_WS, table));
		try {
			socket.send({
				type: 'subscribe',
				id: 'window',
				query: { orderBy: [{ field: 'rank', direction: 'asc' }], limit: 2 }
			});
			const snapshot = await socket.next((frame) => frame.type === 'snapshot', 'the snapshot');
			expect(snapshot.docs?.map((doc) => doc.id)).toEqual(['w10', 'w20']);

			// Inserting rank 15 pulls w15 in and pushes w20 out: both deltas.
			const created = await request.post(dbRowsPath(DB_PROJECT, table), {
				data: { id: 'w15', data: { rank: 15 } }
			});
			expect(created.status(), await created.text()).toBe(201);

			const added = await socket.next(
				(frame) => frame.type === 'change' && frame.kind === 'added',
				'the added frame for the incoming row'
			);
			expect(added.doc?.id).toBe('w15');

			const removed = await socket.next(
				(frame) => frame.type === 'change' && frame.kind === 'removed',
				'the removed frame for the displaced row'
			);
			expect(removed.doc?.id).toBe('w20');
		} finally {
			socket.close();
		}
	});

	test('subscribe queries over undeclared columns are refused up front', async ({ request }) => {
		const table = `tbad-${run}`;
		const declare = await request.put(dbAdminTablePath(DB_PROJECT, table), {
			data: {
				readAccess: 'public',
				writeAccess: 'public',
				columns: [{ name: 'title', type: 'text' }]
			}
		});
		expect(declare.ok(), await declare.text()).toBeTruthy();

		const socket = await LiveSocket.connect(subscribeUrl(WEB_WS, table));
		try {
			socket.send({
				type: 'subscribe',
				id: 's1',
				query: { where: [{ field: 'ghost', op: '==', value: 1 }] }
			});
			const error = await socket.next((frame) => frame.type === 'error', 'the invalid-query error');
			expect(error.code).toBe('invalid-query');
			expect(error.id).toBe('s1');
		} finally {
			socket.close();
		}
	});

	test('auth-mode tables refuse tokenless subscriptions; the direct socket matches', async ({
		request
	}) => {
		const table = `tsecure-${run}`;
		const declare = await request.put(dbAdminTablePath(DB_PROJECT, table), {
			data: {
				readAccess: 'auth',
				writeAccess: 'auth',
				columns: [{ name: 'title', type: 'text' }]
			}
		});
		expect(declare.ok(), await declare.text()).toBeTruthy();

		for (const base of [WEB_WS, AGENT_WS]) {
			const socket = await LiveSocket.connect(subscribeUrl(base, table));
			try {
				socket.send({ type: 'subscribe', id: 's1', query: {} });
				const error = await socket.next(
					(frame) => frame.type === 'error',
					`the unauthorized error via ${base}`
				);
				expect(error.code).toBe('unauthorized');
			} finally {
				socket.close();
			}
		}
	});
});
