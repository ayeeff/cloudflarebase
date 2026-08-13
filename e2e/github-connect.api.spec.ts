import { request as playwrightRequest, expect, test } from '@playwright/test';
import {
	githubConnectionPath,
	githubConnectionsPath,
	githubInstallPath,
	githubReposPath,
	githubStatePath,
	GITHUB_WEBHOOK_PATH,
	hostingDeployPath,
	projectBranchesPath,
	registryProjectPath,
	SEED_PROJECT
} from './helpers';

/**
 * GitHub push-to-deploy (docs/managed-service-design.md, Phase B).
 *
 * This stack configures NO GitHub App, which is the self-hosted default and
 * the important half of the contract to pin: adding push-to-deploy must not
 * open a single new surface on an install that never asked for it. The
 * connect flow answers 503 honestly, the webhook does not exist, and none of
 * it is reachable without an operator session.
 *
 * The parts that need a real App (installations, repository reads, workflow
 * writes) need GitHub itself, so they are not e2e territory. The pure logic
 * underneath is unit tested in agents/hosting (`tar.unit.test.ts`).
 */

const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 12);
const rootId = `e2e-gh-${runId}`;

/** A cookie-less context - the guard must not see a session. */
function anonymous(baseURL: string | undefined, headers: Record<string, string> = {}) {
	return playwrightRequest.newContext({
		baseURL,
		extraHTTPHeaders: { origin: baseURL ?? '', ...headers },
		storageState: { cookies: [], origins: [] }
	});
}

test.describe('github connect', () => {
	test.beforeAll(async ({ request }) => {
		const created = await request.post('/api/registry/projects', {
			data: { id: rootId, name: `GitHub e2e ${rootId}` }
		});
		expect(created.status(), await created.text()).toBe(201);
	});

	test.afterAll(async ({ request }) => {
		await request.delete(registryProjectPath(rootId));
	});

	test('an unconfigured console reports no App rather than half a flow', async ({ request }) => {
		const state = await request.get(githubStatePath(rootId));
		expect(state.status(), await state.text()).toBe(200);
		const body = (await state.json()) as {
			configured: boolean;
			installations: unknown[];
			connections: unknown[];
		};
		// False is what makes the Hosting page offer the manual token flow.
		expect(body.configured).toBe(false);
		expect(body.installations).toEqual([]);
		expect(body.connections).toEqual([]);
	});

	test('connecting without an App is an honest 503, never a silent no-op', async ({ request }) => {
		const install = await request.get(githubInstallPath(rootId));
		expect(install.status(), await install.text()).toBe(503);

		const repos = await request.get(githubReposPath(rootId));
		expect(repos.status(), await repos.text()).toBe(503);

		const connect = await request.post(githubConnectionsPath(rootId), {
			data: { installationId: 1, repoFullName: 'acme/site', appName: 'site', mode: 'build' }
		});
		expect(connect.status(), await connect.text()).toBe(503);
	});

	test('a connection that does not exist is a 404, not a 500', async ({ request }) => {
		const removed = await request.delete(githubConnectionPath(rootId, 'never-connected'));
		expect(removed.status(), await removed.text()).toBe(404);
	});

	test('every github surface requires an operator session', async ({ baseURL }) => {
		const guest = await anonymous(baseURL);
		try {
			for (const path of [
				githubStatePath(rootId),
				githubInstallPath(rootId),
				githubReposPath(rootId),
				githubConnectionsPath(rootId)
			]) {
				const response = await guest.get(path);
				expect(response.status(), `${path} must require an operator`).toBe(401);
			}
			const connect = await guest.post(githubConnectionsPath(rootId), {
				data: { installationId: 1, repoFullName: 'acme/site', appName: 'site', mode: 'build' }
			});
			expect(connect.status(), 'connecting must require an operator').toBe(401);
			const removed = await guest.delete(githubConnectionPath(rootId, 'site'));
			expect(removed.status(), 'disconnecting must require an operator').toBe(401);
		} finally {
			await guest.dispose();
		}
	});

	test('demo projects cannot start an install', async ({ request }) => {
		// No demo hosting anywhere - the install entry point refuses too, so the
		// upsell is the only thing a demo visitor can reach.
		const install = await request.get(githubInstallPath('demo-abcdef123456'));
		expect(install.status(), await install.text()).toBe(403);
	});

	test('the webhook does not exist on a console with no App', async ({ baseURL }) => {
		const guest = await anonymous(baseURL, { 'x-github-event': 'ping' });
		try {
			const response = await guest.post(GITHUB_WEBHOOK_PATH, { data: { zen: 'hi' } });
			// 404, not 401: there is nothing here to authenticate against. What
			// matters is that it never 500s and never acts on an unsigned body.
			expect(response.status(), await response.text()).toBe(404);
		} finally {
			await guest.dispose();
		}
	});

	test('the webhook is the ONLY route opened under /api/github', async ({ baseURL }) => {
		const guest = await anonymous(baseURL);
		try {
			// The install callback runs in the operator's browser and binds the
			// installation to them - opening it would let anyone claim one.
			const callback = await guest.get('/api/github/callback?installation_id=1&state=x');
			expect(callback.status(), 'the install callback must stay operator-only').toBe(401);
		} finally {
			await guest.dispose();
		}
	});

	test('a JWT-shaped bearer on the deploy surface is a plain 401', async ({ baseURL }) => {
		// GitHub's OIDC token is accepted on exactly the deploy-token surfaces,
		// and a forged one must never fall through to session resolution - the
		// same all-or-nothing contract a `cfbd_` bearer has.
		const forged =
			'eyJhbGciOiJSUzI1NiIsImtpZCI6ImZha2UifQ.eyJyZXBvc2l0b3J5IjoiYWNtZS9zaXRlIn0.c2ln';
		const bearer = await anonymous(baseURL, { authorization: `Bearer ${forged}` });
		try {
			const deploy = await bearer.post(hostingDeployPath(rootId, 'forged'), {
				multipart: {
					meta: JSON.stringify({}),
					'asset:/index.html': {
						name: 'index.html',
						mimeType: 'text/html',
						buffer: Buffer.from('<h1>nope</h1>')
					}
				}
			});
			expect(deploy.status(), 'a forged identity token must not deploy').toBe(401);

			const branch = await bearer.post(projectBranchesPath(rootId), { data: { branch: 'forged' } });
			expect(branch.status(), 'a forged identity token must not create branches').toBe(401);

			// And it is not a session anywhere else either.
			const state = await bearer.get(githubStatePath(SEED_PROJECT));
			expect(state.status(), 'a forged identity token must not read console state').toBe(401);
		} finally {
			await bearer.dispose();
		}
	});
});
