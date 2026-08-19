import { request as playwrightRequest, expect, test } from '@playwright/test';
import {
	hostingAppPath,
	hostingDeployPath,
	hostingOverviewPath,
	hostingTokenPath,
	hostingTokensPath,
	projectBranchesPath,
	registryProjectPath,
	SEED_PROJECT
} from './helpers';

/**
 * Deploy tokens (Phase B): CI's durable
 * credential. The contract this file pins: minted on roots only, the secret
 * appears exactly once and is stored hashed, the `cfbd_` bearer is accepted
 * SOLELY on the deploy and branch-create endpoints for the token's family -
 * everywhere else it is a plain 401 - and revocation ends it immediately.
 */

const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 12);
const rootId = `e2e-tok-${runId}`;
const appName = `tok-${runId}`;

const deployBody = {
	multipart: {
		meta: JSON.stringify({}),
		'asset:/index.html': {
			name: 'index.html',
			mimeType: 'text/html',
			buffer: Buffer.from('<h1>token deploy</h1>')
		}
	}
};

/** A cookie-less context whose only credential is the deploy token. */
function tokenContext(baseURL: string | undefined, token: string) {
	return playwrightRequest.newContext({
		baseURL,
		extraHTTPHeaders: { origin: baseURL ?? '', authorization: `Bearer ${token}` },
		storageState: { cookies: [], origins: [] }
	});
}

test.describe('deploy tokens', () => {
	let secret = '';
	let tokenId = '';

	test.beforeAll(async ({ request }) => {
		const created = await request.post('/api/registry/projects', {
			data: { id: rootId, name: `Token e2e ${rootId}` }
		});
		expect(created.status(), await created.text()).toBe(201);
	});

	test.afterAll(async ({ request }) => {
		await request.delete(registryProjectPath(rootId));
	});

	test('minting returns the secret exactly once', async ({ request }) => {
		const minted = await request.post(hostingTokensPath(rootId), { data: { name: 'ci' } });
		expect(minted.status(), await minted.text()).toBe(201);
		const body = (await minted.json()) as { id: string; token: string };
		expect(body.token).toMatch(/^cfbd_[0-9a-f]{64}$/);
		secret = body.token;
		tokenId = body.id;

		// The list carries metadata only - the secret is unrecoverable.
		const listed = await request.get(hostingTokensPath(rootId));
		expect(listed.status(), await listed.text()).toBe(200);
		const { tokens } = (await listed.json()) as { tokens: Record<string, unknown>[] };
		expect(tokens.some((token) => token.id === tokenId)).toBe(true);
		for (const token of tokens) {
			expect(token.token).toBeUndefined();
			expect(token.tokenHash).toBeUndefined();
		}
	});

	test('branch rows refuse minting - tokens live on the root', async ({ request }) => {
		const branch = await request.post(projectBranchesPath(rootId), { data: { branch: 'ci' } });
		expect(branch.status(), await branch.text()).toBe(201);
		const minted = await request.post(hostingTokensPath(`${rootId}--ci`), {
			data: { name: 'nope' }
		});
		expect(minted.status(), await minted.text()).toBe(400);
	});

	test('a deploy token deploys - and does nothing else', async ({ baseURL }) => {
		const bearer = await tokenContext(baseURL, secret);
		try {
			const deploy = await bearer.post(hostingDeployPath(rootId, appName), deployBody);
			expect(deploy.status(), await deploy.text()).toBe(201);

			// Not a session: every other surface answers 401.
			const overview = await bearer.get(hostingOverviewPath(rootId));
			expect(overview.status(), 'a deploy token must not read the overview').toBe(401);
			const registry = await bearer.get('/api/registry/projects');
			expect(registry.status(), 'a deploy token must not list projects').toBe(401);
			const tokens = await bearer.get(hostingTokensPath(rootId));
			expect(tokens.status(), 'a deploy token must not read tokens').toBe(401);

			// Not transferable: another project's deploys refuse it.
			const foreign = await bearer.post(hostingDeployPath(SEED_PROJECT, appName), deployBody);
			expect(foreign.status(), 'a deploy token is scoped to its family').toBe(401);

			// Not destructive: a credential that ships code must never erase an
			// app - deletion is a session-only surface.
			const erase = await bearer.delete(hostingAppPath(rootId, appName));
			expect(erase.status(), 'a deploy token must not delete apps').toBe(401);
		} finally {
			await bearer.dispose();
		}
	});

	test('a deploy token creates branch rows for new git branches', async ({ baseURL }) => {
		const bearer = await tokenContext(baseURL, secret);
		try {
			const created = await bearer.post(projectBranchesPath(rootId), {
				data: { branch: 'preview-x' }
			});
			expect(created.status(), await created.text()).toBe(201);
			const again = await bearer.post(projectBranchesPath(rootId), {
				data: { branch: 'preview-x' }
			});
			expect(again.status(), 'the second create is the idempotent 409').toBe(409);

			// ... and can then deploy to the branch it minted.
			const deploy = await bearer.post(
				hostingDeployPath(`${rootId}--preview-x`, appName),
				deployBody
			);
			expect(deploy.status(), await deploy.text()).toBe(201);
			expect(((await deploy.json()) as { subdomain: string }).subdomain).toBe(
				`${appName}-preview-x`
			);
		} finally {
			await bearer.dispose();
		}
	});

	test('revocation ends the token immediately', async ({ request, baseURL }) => {
		const revoked = await request.delete(hostingTokenPath(rootId, tokenId));
		expect(revoked.status(), await revoked.text()).toBe(200);

		const bearer = await tokenContext(baseURL, secret);
		try {
			const deploy = await bearer.post(hostingDeployPath(rootId, appName), deployBody);
			expect(deploy.status(), 'a revoked token must not deploy').toBe(401);
		} finally {
			await bearer.dispose();
		}
	});

	test('a fabricated token is a plain 401', async ({ baseURL }) => {
		const bearer = await tokenContext(baseURL, `cfbd_${'0'.repeat(64)}`);
		try {
			const deploy = await bearer.post(hostingDeployPath(rootId, appName), deployBody);
			expect(deploy.status()).toBe(401);
		} finally {
			await bearer.dispose();
		}
	});
});
