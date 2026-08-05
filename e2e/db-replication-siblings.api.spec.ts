import { expect, test } from '@playwright/test';
import {
	DB_PROJECT,
	dbAdminCollectionPath,
	dbAdminTablePath,
	dbDocumentsPath,
	dbRowsPath
} from './helpers';
import { LiveSocket, WEB_WS } from './live-socket';

/**
 * Sibling spawn on socket pressure: env.test forces SIBLING_SPAWN_SOCKETS=2
 * and a 250ms sibling routing cache, so a third subscriber in a region must
 * land on `r:<region>:2` - pinning the whole chain: replica socket-count
 * reports -> primary registry -> repSubscribeTarget pick -> worker routing ->
 * sibling bootstrap/registration -> n>1 push fan-out -> linger on drain ->
 * inclusion in the disable fan-out. The demo gate (demo shards never spawn
 * siblings) is agent-side only; env.test deliberately leaves the agent's
 * DEMO_MODE unset, and the demo per-connection subscription cap keeps real
 * demo pressure unreachable anyway.
 */

const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
/** env.test SIBLING_ROUTING_TTL_MS, plus slack for the wall clock. */
const SIBLING_TTL_MS = 400;

function subscribeUrl(kind: 'collections' | 'tables', name: string, region: string): string {
	return `${WEB_WS}/agents/db-agent/${DB_PROJECT}/${kind}/${name}/subscribe?cfb-region=${region}`;
}

function statusPath(name: string): string {
	return `/api/projects/${DB_PROJECT}/db/admin/replication/${encodeURIComponent(name)}`;
}

interface StatusReplica {
	id: string;
	push: boolean;
	sockets: number;
}

test.describe('db agent (sibling spawn)', () => {
	test.skip(!!process.env.BASE_URL, 'needs the env.test spawn threshold and WebSocket pins');

	async function replicaById(
		request: import('@playwright/test').APIRequestContext,
		name: string,
		id: string
	): Promise<StatusReplica | undefined> {
		const status = (await (await request.get(statusPath(name))).json()) as {
			replicas: StatusReplica[];
		};
		return status.replicas.find((replica) => replica.id === id);
	}

	test('socket pressure spawns a second collection sibling that receives pushes', async ({
		request
	}) => {
		const collection = `rsib-${run}`;
		const provision = await request.put(dbAdminCollectionPath(DB_PROJECT, collection), {
			data: { readAccess: 'public', writeAccess: 'public', replication: 'auto' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		const sockets: LiveSocket[] = [];
		try {
			// Two subscribers fill sibling 1 to the test threshold.
			for (const id of ['s1', 's2']) {
				const socket = await LiveSocket.connect(subscribeUrl('collections', collection, 'weur'));
				sockets.push(socket);
				socket.send({ type: 'subscribe', id, query: { limit: 10 } });
				await socket.next((frame) => frame.type === 'snapshot', `the ${id} snapshot`);
			}

			// The replica's step-debounced report reaches the primary's registry.
			await expect
				.poll(async () => (await replicaById(request, collection, 'r:weur:1'))?.sockets ?? 0)
				.toBeGreaterThanOrEqual(2);

			// Let the worker's sibling routing cache expire, then the next
			// subscriber must be routed to (and thereby spawn) sibling 2.
			await new Promise((resolve) => setTimeout(resolve, SIBLING_TTL_MS));
			const third = await LiveSocket.connect(subscribeUrl('collections', collection, 'weur'));
			sockets.push(third);
			third.send({ type: 'subscribe', id: 's3', query: { limit: 10 } });
			await third.next((frame) => frame.type === 'snapshot', 'the sibling snapshot');

			await expect
				.poll(async () => (await replicaById(request, collection, 'r:weur:2'))?.push ?? false)
				.toBe(true);

			// A primary write fans out to BOTH siblings' subscribers.
			const created = await request.post(dbDocumentsPath(DB_PROJECT, collection), {
				data: { id: 'fan', data: { title: 'both siblings' } }
			});
			expect(created.status(), await created.text()).toBe(201);
			for (const [socket, label] of [
				[sockets[0], 'sibling 1'],
				[third, 'sibling 2']
			] as const) {
				const added = await socket.next(
					(frame) => frame.type === 'change' && frame.kind === 'added',
					`the added frame on ${label}`
				);
				expect(added.doc?.id).toBe('fan');
			}

			// Drain sibling 2: it stops receiving pushes but stays registered -
			// re-pressurization reuses it, and the erase fan-out must know it.
			third.close();
			await expect
				.poll(async () => (await replicaById(request, collection, 'r:weur:2'))?.push ?? true)
				.toBe(false);
			expect(await replicaById(request, collection, 'r:weur:2')).toBeTruthy();

			// Disabling replication destroys every sibling, not just :1.
			const disable = await request.put(dbAdminCollectionPath(DB_PROJECT, collection), {
				data: { readAccess: 'public', writeAccess: 'public', replication: 'off' }
			});
			expect(disable.ok(), await disable.text()).toBeTruthy();
			await expect
				.poll(async () => {
					const status = (await (await request.get(statusPath(collection))).json()) as {
						replicas: StatusReplica[];
					};
					return status.replicas.length;
				})
				.toBe(0);
		} finally {
			for (const socket of sockets) socket.close();
		}
	});

	test('tables spawn siblings through the same chain', async ({ request }) => {
		const table = `rsibt-${run}`;
		const declare = await request.put(dbAdminTablePath(DB_PROJECT, table), {
			data: {
				readAccess: 'public',
				writeAccess: 'public',
				replication: 'auto',
				columns: [{ name: 'title', type: 'text', nullable: false }]
			}
		});
		expect(declare.ok(), await declare.text()).toBeTruthy();

		const sockets: LiveSocket[] = [];
		try {
			for (const id of ['t1', 't2']) {
				const socket = await LiveSocket.connect(subscribeUrl('tables', table, 'apac'));
				sockets.push(socket);
				socket.send({ type: 'subscribe', id, query: { limit: 10 } });
				await socket.next((frame) => frame.type === 'snapshot', `the ${id} snapshot`);
			}
			await expect
				.poll(async () => (await replicaById(request, table, 'r:apac:1'))?.sockets ?? 0)
				.toBeGreaterThanOrEqual(2);

			await new Promise((resolve) => setTimeout(resolve, SIBLING_TTL_MS));
			const third = await LiveSocket.connect(subscribeUrl('tables', table, 'apac'));
			sockets.push(third);
			third.send({ type: 'subscribe', id: 't3', query: { limit: 10 } });
			await third.next((frame) => frame.type === 'snapshot', 'the sibling snapshot');

			await expect
				.poll(async () => (await replicaById(request, table, 'r:apac:2'))?.push ?? false)
				.toBe(true);

			const created = await request.post(dbRowsPath(DB_PROJECT, table), {
				data: { id: 'row1', data: { title: 'typed fan-out' } }
			});
			expect(created.status(), await created.text()).toBe(201);
			for (const [socket, label] of [
				[sockets[0], 'sibling 1'],
				[third, 'sibling 2']
			] as const) {
				const added = await socket.next(
					(frame) => frame.type === 'change' && frame.kind === 'added',
					`the added frame on ${label}`
				);
				expect(added.doc?.id).toBe('row1');
			}
		} finally {
			for (const socket of sockets) socket.close();
		}
	});
});
