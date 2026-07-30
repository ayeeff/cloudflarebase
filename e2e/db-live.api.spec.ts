import { expect, test } from '@playwright/test';
import { DB_PROJECT, dbAdminCollectionPath, dbDocumentPath, dbDocumentsPath } from './helpers';

/**
 * Live queries over the raw WebSocket protocol, both through the built web
 * worker (which pins the /agents/* WebSocket passthrough) and directly
 * against the agent worker. Local stack only: deriving WebSocket URLs from an
 * arbitrary BASE_URL is out of scope, so the whole file skips on remote runs,
 * like the direct agent smoke test does.
 *
 * Collections carry a per-run suffix so a reused local stack never leaks
 * documents from an earlier run into a snapshot or a window.
 */

const WEB_WS = 'ws://localhost:8797';
const AGENT_WS = 'ws://localhost:8799';
const FRAME_TIMEOUT_MS = 5_000;

const run = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

function subscribeUrl(base: string, collection: string): string {
	return `${base}/agents/db-agent/${DB_PROJECT}/collections/${collection}/subscribe`;
}

interface Frame {
	type: string;
	id?: string;
	kind?: string;
	code?: string;
	docs?: { id: string; data: Record<string, unknown> }[];
	doc?: { id: string; data: Record<string, unknown> };
	[key: string]: unknown;
}

/**
 * Collects every server frame and hands them out once each, so a test can
 * await "the added frame" and "the removed frame" without caring which the
 * server sent first.
 */
class LiveSocket {
	private readonly socket: WebSocket;
	private readonly frames: Frame[] = [];
	private readonly claimed = new Set<number>();
	private readonly opened: Promise<void>;

	private constructor(url: string) {
		this.socket = new WebSocket(url);
		this.opened = new Promise((resolve, reject) => {
			this.socket.addEventListener('open', () => resolve(), { once: true });
			this.socket.addEventListener(
				'error',
				() => reject(new Error(`WebSocket failed to open: ${url}`)),
				{ once: true }
			);
		});
		this.socket.addEventListener('message', (event) => {
			this.frames.push(JSON.parse(String(event.data)) as Frame);
		});
	}

	static async connect(url: string): Promise<LiveSocket> {
		const live = new LiveSocket(url);
		await live.opened;
		return live;
	}

	send(frame: unknown): void {
		this.socket.send(JSON.stringify(frame));
	}

	sendRaw(payload: string): void {
		this.socket.send(payload);
	}

	/** First unclaimed frame matching the predicate, or a descriptive timeout. */
	async next(predicate: (frame: Frame) => boolean, description: string): Promise<Frame> {
		const deadline = Date.now() + FRAME_TIMEOUT_MS;
		for (;;) {
			const index = this.frames.findIndex(
				(frame, position) => !this.claimed.has(position) && predicate(frame)
			);
			if (index !== -1) {
				this.claimed.add(index);
				return this.frames[index];
			}
			if (Date.now() > deadline) {
				throw new Error(
					`timed out waiting for ${description}; frames so far: ${JSON.stringify(this.frames)}`
				);
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}

	close(): void {
		try {
			this.socket.close();
		} catch {
			// already closed - nothing to release
		}
	}
}

test.describe('db agent (live queries)', () => {
	test.skip(!!process.env.BASE_URL, 'WebSocket endpoints are pinned on the local stack only');

	test('streams snapshot, added, modified, and removed frames through the web worker', async ({
		request
	}) => {
		const collection = `live-flow-${run}`;
		const provision = await request.put(dbAdminCollectionPath(DB_PROJECT, collection), {
			data: { readAccess: 'public', writeAccess: 'public' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		// Seeded out of rank order on purpose: the snapshot must come back in
		// query order, not insertion order.
		for (const [id, rank] of [
			['flow-second', 2],
			['flow-first', 1]
		] as const) {
			const created = await request.post(dbDocumentsPath(DB_PROJECT, collection), {
				data: { id, data: { kind: 'task', rank } }
			});
			expect(created.status(), await created.text()).toBe(201);
		}

		const socket = await LiveSocket.connect(subscribeUrl(WEB_WS, collection));
		try {
			socket.send({
				type: 'subscribe',
				id: 's1',
				query: {
					where: [{ field: 'kind', op: '==', value: 'task' }],
					orderBy: [{ field: 'rank', direction: 'asc' }]
				}
			});
			const snapshot = await socket.next((frame) => frame.type === 'snapshot', 'the snapshot');
			expect(snapshot.id).toBe('s1');
			expect(snapshot.docs?.map((doc) => doc.id)).toEqual(['flow-first', 'flow-second']);

			// A REST create that matches the predicate -> added.
			const created = await request.post(dbDocumentsPath(DB_PROJECT, collection), {
				data: { id: 'flow-third', data: { kind: 'task', rank: 3 } }
			});
			expect(created.status(), await created.text()).toBe(201);
			const added = await socket.next(
				(frame) => frame.type === 'change' && frame.kind === 'added',
				'the added frame'
			);
			expect(added.id).toBe('s1');
			expect(added.doc?.id).toBe('flow-third');

			// A PATCH that keeps the predicate -> modified.
			const kept = await request.patch(dbDocumentPath(DB_PROJECT, collection, 'flow-third'), {
				data: { note: 'still a task' }
			});
			expect(kept.ok(), await kept.text()).toBeTruthy();
			const modified = await socket.next(
				(frame) => frame.type === 'change' && frame.kind === 'modified',
				'the modified frame'
			);
			expect(modified.doc?.id).toBe('flow-third');
			expect(modified.doc?.data.note).toBe('still a task');

			// A PATCH that exits the predicate -> removed.
			const exited = await request.patch(dbDocumentPath(DB_PROJECT, collection, 'flow-third'), {
				data: { kind: 'archived' }
			});
			expect(exited.ok(), await exited.text()).toBeTruthy();
			const removed = await socket.next(
				(frame) => frame.type === 'change' && frame.kind === 'removed',
				'the removed frame'
			);
			expect(removed.doc?.id).toBe('flow-third');

			socket.send({ type: 'unsubscribe', id: 's1' });
			const unsubscribed = await socket.next(
				(frame) => frame.type === 'unsubscribed',
				'the unsubscribe ack'
			);
			expect(unsubscribed.id).toBe('s1');
		} finally {
			socket.close();
		}
	});

	test('rejects malformed frames with an invalid-frame error', async ({ request }) => {
		const collection = `live-frames-${run}`;
		const provision = await request.put(dbAdminCollectionPath(DB_PROJECT, collection), {
			data: { readAccess: 'public', writeAccess: 'public' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		const socket = await LiveSocket.connect(subscribeUrl(WEB_WS, collection));
		try {
			socket.sendRaw('definitely not json');
			const notJson = await socket.next(
				(frame) => frame.type === 'error',
				'the invalid-frame error for a non-JSON payload'
			);
			expect(notJson.code).toBe('invalid-frame');

			socket.send({ type: 'subscribe' }); // missing id and query
			const badShape = await socket.next(
				(frame) => frame.type === 'error',
				'the invalid-frame error for a malformed subscribe'
			);
			expect(badShape.code).toBe('invalid-frame');
		} finally {
			socket.close();
		}
	});

	test('windowed queries emit displacement deltas', async ({ request }) => {
		const collection = `live-window-${run}`;
		const provision = await request.put(dbAdminCollectionPath(DB_PROJECT, collection), {
			data: { readAccess: 'public', writeAccess: 'public' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		for (const [id, rank] of [
			['w10', 10],
			['w20', 20],
			['w30', 30]
		] as const) {
			const created = await request.post(dbDocumentsPath(DB_PROJECT, collection), {
				data: { id, data: { rank } }
			});
			expect(created.status(), await created.text()).toBe(201);
		}

		const socket = await LiveSocket.connect(subscribeUrl(WEB_WS, collection));
		try {
			socket.send({
				type: 'subscribe',
				id: 'window',
				query: { orderBy: [{ field: 'rank', direction: 'asc' }], limit: 2 }
			});
			const snapshot = await socket.next((frame) => frame.type === 'snapshot', 'the snapshot');
			expect(snapshot.docs?.map((doc) => doc.id)).toEqual(['w10', 'w20']);

			// Inserting rank 15 pulls w15 into the window and pushes w20 out: the
			// subscriber must see BOTH deltas, not just the added one.
			const created = await request.post(dbDocumentsPath(DB_PROJECT, collection), {
				data: { id: 'w15', data: { rank: 15 } }
			});
			expect(created.status(), await created.text()).toBe(201);

			const added = await socket.next(
				(frame) => frame.type === 'change' && frame.kind === 'added',
				'the added frame for the incoming document'
			);
			expect(added.doc?.id).toBe('w15');

			const removed = await socket.next(
				(frame) => frame.type === 'change' && frame.kind === 'removed',
				'the removed frame for the displaced document'
			);
			expect(removed.doc?.id).toBe('w20');
		} finally {
			socket.close();
		}
	});

	test('auth-mode collections refuse tokenless subscriptions', async ({ request }) => {
		const collection = `live-secure-${run}`;
		const provision = await request.put(dbAdminCollectionPath(DB_PROJECT, collection), {
			data: { readAccess: 'auth', writeAccess: 'auth' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		const socket = await LiveSocket.connect(subscribeUrl(WEB_WS, collection));
		try {
			socket.send({ type: 'subscribe', id: 's1', query: {} });
			const error = await socket.next((frame) => frame.type === 'error', 'the unauthorized error');
			expect(error.code).toBe('unauthorized');
			expect(error.id).toBe('s1');
		} finally {
			socket.close();
		}
	});

	test('the direct agent socket serves the same protocol', async ({ request }) => {
		// Same Durable Object, reached without the web worker in front - and a
		// REST write through the proxy must still reach this direct subscriber.
		const collection = `live-direct-${run}`;
		const provision = await request.put(dbAdminCollectionPath(DB_PROJECT, collection), {
			data: { readAccess: 'public', writeAccess: 'public' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		const socket = await LiveSocket.connect(subscribeUrl(AGENT_WS, collection));
		try {
			socket.send({ type: 'subscribe', id: 'direct', query: {} });
			const snapshot = await socket.next((frame) => frame.type === 'snapshot', 'the snapshot');
			expect(snapshot.docs).toEqual([]);

			const created = await request.post(dbDocumentsPath(DB_PROJECT, collection), {
				data: { id: 'direct-doc', data: { via: 'proxy' } }
			});
			expect(created.status(), await created.text()).toBe(201);

			const added = await socket.next(
				(frame) => frame.type === 'change' && frame.kind === 'added',
				'the added frame'
			);
			expect(added.id).toBe('direct');
			expect(added.doc?.id).toBe('direct-doc');
		} finally {
			socket.close();
		}
	});
});
