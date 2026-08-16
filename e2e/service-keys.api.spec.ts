import {
	expect,
	request as playwrightRequest,
	test,
	type APIRequestContext
} from '@playwright/test';
import { ensureProject, SCRATCH_PROJECT } from './helpers';

/**
 * Project service keys (docs/service-keys-design.md, SK1).
 *
 * A key is admin-grade on its project's DATA plane, so the tests that matter
 * most are the ones proving what it CANNOT do. In order of how badly each
 * would hurt:
 *
 * 1. it must not work from a browser (any request carrying `Origin`);
 * 2. it must not reach another project - a sibling branch included, because
 *    for data the branch IS the isolation boundary;
 * 3. it must not escalate: no registry (so it cannot delete its own project),
 *    no console, no CLI, no hosting, and no minting or revoking keys;
 * 4. revocation must bite immediately.
 *
 * The suite's stored operator session is what mints keys, so the key-using
 * contexts here are deliberately cookie-less: a service key must stand on its
 * own, never on an ambient session.
 */

const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const KEY_PROJECT = `svckey-${run}`.slice(0, 20);

function base(baseURL: string | undefined): string {
	return baseURL ?? process.env.BASE_URL ?? 'http://localhost:8797';
}

/**
 * No cookies, and NO Origin - exactly how a server calls.
 *
 * The blank `origin` is load-bearing, not decoration: the `api` project sets
 * `extraHTTPHeaders: { origin: baseURL }` for every context it makes, and a
 * context built here inherits it. Without the override this context looks like
 * a BROWSER to the guard, every request 401s, and the suite would "pass" on
 * nothing but negative assertions. Blanking it is how a test expresses the one
 * thing a browser can never do - omit the header.
 */
async function serverContext(baseURL: string | undefined): Promise<APIRequestContext> {
	return playwrightRequest.newContext({
		baseURL: base(baseURL),
		extraHTTPHeaders: { origin: '' }
	});
}

test.describe('service keys', () => {
	let key = '';
	let keyId = '';

	test.beforeAll(async ({ playwright, baseURL }) => {
		const operator = await playwright.request.newContext({
			baseURL: base(baseURL),
			extraHTTPHeaders: { origin: base(baseURL) },
			storageState: 'e2e/.auth/console.json'
		});
		try {
			await ensureProject(operator, KEY_PROJECT);
			const minted = await operator.post(`/api/projects/${KEY_PROJECT}/keys`, {
				data: { name: 'ci' }
			});
			expect(minted.status(), await minted.text()).toBe(201);
			const body = await minted.json();
			expect(body.key).toMatch(/^cfbs_[0-9a-f]{64}$/);
			key = body.key;
			keyId = body.id;

			// The secret is shown exactly once: listing returns metadata only.
			const listed = await operator.get(`/api/projects/${KEY_PROJECT}/keys`);
			expect(listed.ok()).toBeTruthy();
			const { keys } = await listed.json();
			expect(keys).toHaveLength(1);
			expect(JSON.stringify(keys)).not.toContain(key);
		} finally {
			await operator.dispose();
		}
	});

	test('reads and writes its own project, with no user and no session', async ({ baseURL }) => {
		const server = await serverContext(baseURL);
		try {
			const collection = `svc-${run}`;
			// An `auth`-mode collection: a tokenless caller could not touch this
			// through the public path. Admin-grade is the whole point.
			const declare = await server.put(
				`/api/projects/${KEY_PROJECT}/db/admin/collections/${collection}`,
				{
					headers: { authorization: `Bearer ${key}` },
					data: { readAccess: 'auth', writeAccess: 'auth' }
				}
			);
			expect(declare.ok(), await declare.text()).toBeTruthy();

			const write = await server.put(
				`/api/projects/${KEY_PROJECT}/db/admin/collections/${collection}/documents/seed-1`,
				{
					headers: { authorization: `Bearer ${key}` },
					data: { data: { title: 'from a cron' } }
				}
			);
			expect(write.ok(), await write.text()).toBeTruthy();

			const read = await server.post(`/api/projects/${KEY_PROJECT}/db/admin/query`, {
				headers: { authorization: `Bearer ${key}` },
				data: { collection, query: { limit: 10 } }
			});
			expect(read.ok(), await read.text()).toBeTruthy();
			const { docs } = await read.json();
			expect(docs.map((doc: { id: string }) => doc.id)).toContain('seed-1');
		} finally {
			await server.dispose();
		}
	});

	test('is refused from a browser - any Origin at all', async ({ baseURL }) => {
		// The single highest-value guard: a key pasted into frontend code fails
		// at the developer's desk instead of shipping inside a JS bundle.
		const browser = await playwrightRequest.newContext({
			baseURL: base(baseURL),
			extraHTTPHeaders: { origin: base(baseURL) }
		});
		try {
			const denied = await browser.post(`/api/projects/${KEY_PROJECT}/db/admin/query`, {
				headers: { authorization: `Bearer ${key}` },
				data: { collection: 'anything', query: { limit: 1 } }
			});
			expect(denied.status()).toBe(401);

			// Even a foreign origin - the refusal is on the header's PRESENCE,
			// not on whether it is trusted, so no allowlist can ever admit one.
			const foreign = await playwrightRequest.newContext({
				baseURL: base(baseURL),
				extraHTTPHeaders: { origin: 'https://evil.example' }
			});
			try {
				const denied2 = await foreign.post(`/api/projects/${KEY_PROJECT}/db/admin/query`, {
					headers: { authorization: `Bearer ${key}` },
					data: { collection: 'anything', query: { limit: 1 } }
				});
				expect(denied2.status()).toBe(401);
			} finally {
				await foreign.dispose();
			}
		} finally {
			await browser.dispose();
		}
	});

	test('cannot reach another project, or escalate anywhere', async ({ baseURL }) => {
		const server = await serverContext(baseURL);
		try {
			// POSITIVE CONTROL FIRST. Every other assertion here expects 401, so
			// without this they would all pass just as happily if the key never
			// worked at all - which is exactly the state an earlier run of this
			// spec was in. Prove the key is live in THIS context before proving
			// what it cannot reach.
			const live = await server.get(`/api/projects/${KEY_PROJECT}/db/overview`, {
				headers: { authorization: `Bearer ${key}` }
			});
			expect(live.ok(), await live.text()).toBeTruthy();

			// Another project's data - the tenant boundary.
			const other = await server.post(`/api/projects/${SCRATCH_PROJECT}/db/admin/query`, {
				headers: { authorization: `Bearer ${key}` },
				data: { collection: 'anything', query: { limit: 1 } }
			});
			expect(other.status()).toBe(401);

			// A key must not be able to grow, outlive itself, or destroy what it
			// belongs to. Every one of these is a plain 401, never a session.
			const escalations: [string, string][] = [
				['GET', `/api/projects/${KEY_PROJECT}/keys`],
				['POST', `/api/projects/${KEY_PROJECT}/keys`],
				['DELETE', `/api/projects/${KEY_PROJECT}/keys/${keyId}`],
				['GET', `/api/registry/projects`],
				['DELETE', `/api/registry/projects/${KEY_PROJECT}`],
				['POST', `/api/projects/${KEY_PROJECT}/branches`],
				['GET', `/api/projects/${KEY_PROJECT}/hosting/apps`],
				['POST', `/api/cli/token`]
			];
			for (const [method, path] of escalations) {
				const response = await server.fetch(path, {
					method,
					headers: { authorization: `Bearer ${key}` },
					data: {}
				});
				expect(response.status(), `${method} ${path}`).toBe(401);
			}

			// And the project still exists after all that.
			const operator = await playwrightRequest.newContext({
				baseURL: base(baseURL),
				extraHTTPHeaders: { origin: base(baseURL) },
				storageState: 'e2e/.auth/console.json'
			});
			try {
				const alive = await operator.get(`/api/projects/${KEY_PROJECT}/keys`);
				expect(alive.ok()).toBeTruthy();
			} finally {
				await operator.dispose();
			}
		} finally {
			await server.dispose();
		}
	});

	test('a garbage or revoked key is a plain 401, never a session fallback', async ({ baseURL }) => {
		const server = await serverContext(baseURL);
		try {
			// Positive control, same reason as above: the revocation assertion
			// below is only meaningful if the key worked immediately before it.
			const before = await server.get(`/api/projects/${KEY_PROJECT}/db/overview`, {
				headers: { authorization: `Bearer ${key}` }
			});
			expect(before.ok(), await before.text()).toBeTruthy();

			const garbage = await server.post(`/api/projects/${KEY_PROJECT}/db/admin/query`, {
				headers: { authorization: `Bearer cfbs_${'0'.repeat(64)}` },
				data: { collection: 'anything', query: { limit: 1 } }
			});
			expect(garbage.status()).toBe(401);

			const operator = await playwrightRequest.newContext({
				baseURL: base(baseURL),
				extraHTTPHeaders: { origin: base(baseURL) },
				storageState: 'e2e/.auth/console.json'
			});
			try {
				const revoked = await operator.delete(`/api/projects/${KEY_PROJECT}/keys/${keyId}`);
				expect(revoked.ok(), await revoked.text()).toBeTruthy();
			} finally {
				await operator.dispose();
			}

			// Immediately - there is no verification cache in front of the digest
			// lookup, precisely so a leaked key cannot outlive its revocation.
			const dead = await server.post(`/api/projects/${KEY_PROJECT}/db/admin/query`, {
				headers: { authorization: `Bearer ${key}` },
				data: { collection: 'anything', query: { limit: 1 } }
			});
			expect(dead.status()).toBe(401);
		} finally {
			await server.dispose();
		}
	});
});
