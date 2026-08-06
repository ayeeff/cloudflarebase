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
	dbDocumentsPath,
	dbRowsPath,
	uniqueEmail
} from './helpers';
import { LiveSocket, WEB_WS } from './live-socket';

/**
 * The realtime gateway: ONE WebSocket to `/agents/db-agent/<pid>/realtime`
 * multiplexing live queries across collections AND tables. The gateway holds
 * no data - shards register the subscription (`remoteSubscribe`, re-verifying
 * tokens themselves) and deliver resolved frames back by RPC - so these specs
 * pin the whole chain: subscribe fan-out, per-shard snapshots, write
 * deliveries from both engines onto one socket, replica-hosted subscriptions,
 * JWT parity with direct shard sockets, and gateway sibling spawn under the
 * env.test threshold.
 */

const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
/** env.test SIBLING_ROUTING_TTL_MS, plus slack for the wall clock. */
const SIBLING_TTL_MS = 400;

function realtimeUrl(region = 'weur'): string {
	return `${WEB_WS}/agents/db-agent/${DB_PROJECT}/realtime?cfb-region=${region}`;
}

const realtimeAdminPath = `/api/projects/${DB_PROJECT}/db/admin/realtime`;

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
				name: 'Gateway Spec User',
				email: uniqueEmail(prefix),
				password: 'gw-spec-password-1'
			}
		});
		expect(signUp.ok(), await signUp.text()).toBeTruthy();
		const sessionToken = signUp.headers()['set-auth-token'];
		expect(sessionToken).toBeTruthy();

		const token = await anon.get(authPath(DB_PROJECT, 'token'), {
			headers: { authorization: `Bearer ${sessionToken}` }
		});
		expect(token.ok(), await token.text()).toBeTruthy();
		const { token: jwt } = await token.json();
		expect(jwt).toBeTruthy();
		return jwt;
	} finally {
		await anon.dispose();
	}
}

test.describe('db agent (realtime gateway)', () => {
	test.skip(!!process.env.BASE_URL, 'needs the env.test region override and WebSocket pins');

	test('one socket multiplexes documents and rows, and unsubscribe is per-query', async ({
		request
	}) => {
		const collection = `gwc-${run}`;
		const table = `gwt-${run}`;
		const provision = await request.put(dbAdminCollectionPath(DB_PROJECT, collection), {
			data: { readAccess: 'public', writeAccess: 'public', replication: 'off' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();
		const declare = await request.put(dbAdminTablePath(DB_PROJECT, table), {
			data: {
				readAccess: 'public',
				writeAccess: 'public',
				replication: 'off',
				columns: [{ name: 'title', type: 'text', nullable: false }]
			}
		});
		expect(declare.ok(), await declare.text()).toBeTruthy();

		const socket = await LiveSocket.connect(realtimeUrl());
		try {
			socket.send({
				type: 'subscribe',
				id: 'c1',
				shard: { kind: 'collection', name: collection },
				query: { limit: 10 }
			});
			socket.send({
				type: 'subscribe',
				id: 't1',
				shard: { kind: 'table', name: table },
				query: { limit: 10 }
			});
			await socket.next(
				(frame) => frame.type === 'snapshot' && frame.id === 'c1',
				'the collection snapshot'
			);
			await socket.next(
				(frame) => frame.type === 'snapshot' && frame.id === 't1',
				'the table snapshot'
			);

			// Writes on BOTH engines arrive as deltas on the one socket.
			const doc = await request.post(dbDocumentsPath(DB_PROJECT, collection), {
				data: { id: 'doc-1', data: { title: 'from documents' } }
			});
			expect(doc.status(), await doc.text()).toBe(201);
			const row = await request.post(dbRowsPath(DB_PROJECT, table), {
				data: { id: 'row-1', data: { title: 'from rows' } }
			});
			expect(row.status(), await row.text()).toBe(201);

			const docAdded = await socket.next(
				(frame) => frame.type === 'change' && frame.id === 'c1' && frame.kind === 'added',
				'the document delta'
			);
			expect(docAdded.doc?.id).toBe('doc-1');
			const rowAdded = await socket.next(
				(frame) => frame.type === 'change' && frame.id === 't1' && frame.kind === 'added',
				'the row delta'
			);
			expect(rowAdded.doc?.id).toBe('row-1');

			// Unsubscribing one query leaves the other live on the same socket.
			socket.send({ type: 'unsubscribe', id: 'c1' });
			await socket.next(
				(frame) => frame.type === 'unsubscribed' && frame.id === 'c1',
				'the unsubscribe ack'
			);

			const doc2 = await request.post(dbDocumentsPath(DB_PROJECT, collection), {
				data: { id: 'doc-2', data: { title: 'nobody watching' } }
			});
			expect(doc2.status(), await doc2.text()).toBe(201);
			const row2 = await request.post(dbRowsPath(DB_PROJECT, table), {
				data: { id: 'row-2', data: { title: 'still watching' } }
			});
			expect(row2.status(), await row2.text()).toBe(201);
			await socket.next(
				(frame) => frame.type === 'change' && frame.id === 't1' && frame.doc?.id === 'row-2',
				'the second row delta'
			);
			// The shard dropped the unsubscribed query: no doc-2 frame arrived
			// alongside (nor after a settle window for the RPC lanes).
			await new Promise((resolve) => setTimeout(resolve, 400));
			expect(socket.peek((frame) => frame.id === 'c1' && frame.type === 'change')).toBeUndefined();
		} finally {
			socket.close();
		}
	});

	test('a replicated shard serves gateway subscriptions from the region replica', async ({
		request
	}) => {
		const collection = `gwr-${run}`;
		const provision = await request.put(dbAdminCollectionPath(DB_PROJECT, collection), {
			data: { readAccess: 'public', writeAccess: 'public', replication: 'auto' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		const socket = await LiveSocket.connect(realtimeUrl('apac'));
		try {
			socket.send({
				type: 'subscribe',
				id: 'r1',
				shard: { kind: 'collection', name: collection },
				query: { limit: 10 }
			});
			await socket.next((frame) => frame.type === 'snapshot', 'the replica snapshot');

			// The replica registered a via-subscription and flipped its push
			// flag - a primary write must arrive through repApply -> replica
			// live engine -> gateway RPC -> this socket.
			const status = (await (
				await request.get(`/api/projects/${DB_PROJECT}/db/admin/replication/${collection}`)
			).json()) as { replicas: { id: string; push: boolean }[] };
			expect(status.replicas.find((replica) => replica.id === 'r:apac:1')?.push).toBe(true);

			const created = await request.post(dbDocumentsPath(DB_PROJECT, collection), {
				data: { id: 'rep-doc', data: { title: 'replicated delivery' } }
			});
			expect(created.status(), await created.text()).toBe(201);
			const added = await socket.next(
				(frame) => frame.type === 'change' && frame.kind === 'added',
				'the replica-delivered delta'
			);
			expect(added.doc?.id).toBe('rep-doc');
		} finally {
			socket.close();
		}
	});

	test('token gates hold via the gateway exactly as on direct shard sockets', async ({
		request,
		baseURL
	}) => {
		const gated = `gwa-${run}`;
		const open = `gwo-${run}`;
		for (const [name, readAccess] of [
			[gated, 'auth'],
			[open, 'public']
		] as const) {
			const provision = await request.put(dbAdminCollectionPath(DB_PROJECT, name), {
				data: { readAccess, writeAccess: 'public', replication: 'off' }
			});
			expect(provision.ok(), await provision.text()).toBeTruthy();
		}

		const socket = await LiveSocket.connect(realtimeUrl());
		try {
			// Tokenless subscribe to the gated shard fails THAT query only...
			socket.send({
				type: 'subscribe',
				id: 'a1',
				shard: { kind: 'collection', name: gated },
				query: {}
			});
			const refused = await socket.next(
				(frame) => frame.type === 'error' && frame.id === 'a1',
				'the unauthorized error'
			);
			expect(refused.code).toBe('unauthorized');

			// ...while a public subscription on the same socket works.
			socket.send({
				type: 'subscribe',
				id: 'p1',
				shard: { kind: 'collection', name: open },
				query: {}
			});
			await socket.next(
				(frame) => frame.type === 'snapshot' && frame.id === 'p1',
				'the public snapshot'
			);

			// A valid project JWT opens the gated shard - the shard verified it,
			// never the gateway.
			const jwt = await projectUserToken(baseURL, 'gw-auth');
			socket.send({
				type: 'subscribe',
				id: 'a2',
				shard: { kind: 'collection', name: gated },
				query: {},
				token: jwt
			});
			await socket.next(
				(frame) => frame.type === 'snapshot' && frame.id === 'a2',
				'the authorized snapshot'
			);
		} finally {
			socket.close();
		}
	});

	test('wrong-kind and undeclared shard subscriptions fail per-query', async ({ request }) => {
		const collection = `gwk-${run}`;
		const provision = await request.put(dbAdminCollectionPath(DB_PROJECT, collection), {
			data: { readAccess: 'public', writeAccess: 'public', replication: 'off' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		const socket = await LiveSocket.connect(realtimeUrl());
		try {
			socket.send({
				type: 'subscribe',
				id: 'k1',
				shard: { kind: 'table', name: collection },
				query: {}
			});
			const mismatch = await socket.next(
				(frame) => frame.type === 'error' && frame.id === 'k1',
				'the kind-mismatch error'
			);
			expect(mismatch.code).toBe('shard-unavailable');

			socket.send({
				type: 'subscribe',
				id: 'k2',
				shard: { kind: 'table', name: `never-declared-${run}` },
				query: {}
			});
			const missing = await socket.next(
				(frame) => frame.type === 'error' && frame.id === 'k2',
				'the undeclared-table error'
			);
			expect(missing.code).toBe('shard-unavailable');
		} finally {
			socket.close();
		}
	});

	test('socket pressure spawns a second gateway sibling in the region', async ({ request }) => {
		const collection = `gws-${run}`;
		const provision = await request.put(dbAdminCollectionPath(DB_PROJECT, collection), {
			data: { readAccess: 'public', writeAccess: 'public', replication: 'off' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		const sockets: LiveSocket[] = [];
		try {
			// Two sockets fill gw:oc:1 to the env.test threshold (2)...
			for (const id of ['g1', 'g2']) {
				const socket = await LiveSocket.connect(realtimeUrl('oc'));
				sockets.push(socket);
				socket.send({
					type: 'subscribe',
					id,
					shard: { kind: 'collection', name: collection },
					query: { limit: 5 }
				});
				await socket.next((frame) => frame.type === 'snapshot', `the ${id} snapshot`);
			}
			await expect
				.poll(async () => {
					const overview = (await (await request.get(realtimeAdminPath)).json()) as {
						gateways: { id: string; sockets: number }[];
					};
					return overview.gateways.find((gateway) => gateway.id === 'gw:oc:1')?.sockets ?? 0;
				})
				.toBeGreaterThanOrEqual(2);

			// ...so after the routing cache expires the next socket lands on
			// (and thereby spawns) gw:oc:2, which still delivers.
			await new Promise((resolve) => setTimeout(resolve, SIBLING_TTL_MS));
			const third = await LiveSocket.connect(realtimeUrl('oc'));
			sockets.push(third);
			third.send({
				type: 'subscribe',
				id: 'g3',
				shard: { kind: 'collection', name: collection },
				query: { limit: 5 }
			});
			await third.next((frame) => frame.type === 'snapshot', 'the sibling snapshot');

			await expect
				.poll(async () => {
					const overview = (await (await request.get(realtimeAdminPath)).json()) as {
						gateways: { id: string }[];
					};
					return overview.gateways.some((gateway) => gateway.id === 'gw:oc:2');
				})
				.toBe(true);

			const created = await request.post(dbDocumentsPath(DB_PROJECT, collection), {
				data: { id: 'gw-fan', data: { title: 'both gateways' } }
			});
			expect(created.status(), await created.text()).toBe(201);
			for (const [socket, label] of [
				[sockets[0], 'gateway 1'],
				[third, 'gateway 2']
			] as const) {
				const added = await socket.next(
					(frame) => frame.type === 'change' && frame.kind === 'added',
					`the added frame on ${label}`
				);
				expect(added.doc?.id).toBe('gw-fan');
			}
		} finally {
			for (const socket of sockets) socket.close();
		}
	});
});
