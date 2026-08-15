import { expect, test } from '@playwright/test';
import {
	hostingAppPath,
	hostingClaimsPath,
	hostingDeployPath,
	hostingDeploysPath,
	hostingOverviewPath,
	hostingTokensPath,
	projectBranchesPath,
	registryProjectPath
} from './helpers';

/**
 * The stubbed CLI -> console -> agent hosting contract (Phase B of
 * docs/managed-service-design.md): subdomain claims resolve in the control
 * plane with auto-numbering, deploys are multipart uploads the console
 * forwards after pushing the claim, and HOSTING_STUB records everything
 * without a dispatch namespace. Real upload coverage is the opt-in
 * hosting-real spec; this file is what pins the shape for every run.
 */

// Fresh ids per run: claims and registry rows are permanent on locally
// reused stacks. Short enough that `--stg` fits the 48-char ceiling.
const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 12);
const rootId = `e2e-host-${runId}`;
const neighborId = `e2e-hostb-${runId}`;
const appName = `app-${runId}`;

const INDEX_HTML = {
	name: 'index.html',
	mimeType: 'text/html',
	buffer: Buffer.from('<h1>hello from e2e</h1>')
};

function deployBody(extra: Record<string, unknown> = {}) {
	return {
		multipart: {
			meta: JSON.stringify(extra),
			'asset:/index.html': INDEX_HTML
		}
	};
}

test.describe('hosting deploys (stubbed)', () => {
	test.beforeAll(async ({ request }) => {
		for (const id of [rootId, neighborId]) {
			const created = await request.post('/api/registry/projects', {
				data: { id, name: `Hosting e2e ${id}` }
			});
			expect(created.status(), await created.text()).toBe(201);
		}
	});

	test.afterAll(async ({ request }) => {
		// Deleting the roots also deletes branches (child-first) and releases
		// the subdomain claims - keeps reused stacks under the project cap.
		for (const id of [rootId, neighborId]) {
			await request.delete(registryProjectPath(id));
		}
	});

	test('a dry claim previews without claiming', async ({ request }) => {
		const preview = await request.post(hostingClaimsPath(rootId), {
			data: { app: appName, dry: true }
		});
		expect(preview.status(), await preview.text()).toBe(200);
		const body = (await preview.json()) as { subdomain: string; created: boolean };
		expect(body.subdomain).toBe(appName);
		expect(body.created).toBe(false);
	});

	test('the first deploy claims the subdomain and records a stub deploy', async ({ request }) => {
		const deploy = await request.post(hostingDeployPath(rootId, appName), deployBody());
		expect(deploy.status(), await deploy.text()).toBe(201);
		const body = (await deploy.json()) as {
			subdomain: string;
			url: string | null;
			deploy: { status: string; assetCount: number; hasWorker: boolean };
		};
		expect(body.subdomain).toBe(appName);
		expect(body.url).toBe(`https://${appName}.cfbase.dev`);
		expect(body.deploy.status).toBe('stub');
		expect(body.deploy.assetCount).toBe(1);
		expect(body.deploy.hasWorker).toBe(false);
	});

	test('the overview lists the app and its deploy', async ({ request }) => {
		const overview = await request.get(hostingOverviewPath(rootId));
		expect(overview.status(), await overview.text()).toBe(200);
		const body = (await overview.json()) as {
			apps: { name: string; subdomain: string }[];
			recentDeploys: unknown[];
			totalDeploys: number;
			stub: boolean;
			configured: boolean;
		};
		expect(body.apps.map((app) => app.name)).toContain(appName);
		expect(body.totalDeploys).toBeGreaterThanOrEqual(1);
		expect(body.stub).toBe(true);
		expect(body.configured).toBe(true);
	});

	test('deploy history pages over keyset cursors', async ({ request }) => {
		// A second deploy so there are two pages at limit=1.
		const again = await request.post(hostingDeployPath(rootId, appName), deployBody());
		expect(again.status(), await again.text()).toBe(201);

		const first = await request.get(`${hostingDeploysPath(rootId)}?limit=1`);
		expect(first.status(), await first.text()).toBe(200);
		const page1 = (await first.json()) as {
			deploys: { id: string }[];
			total: number;
			cursor: string | null;
		};
		expect(page1.deploys).toHaveLength(1);
		expect(page1.total).toBeGreaterThanOrEqual(2);
		expect(page1.cursor).not.toBeNull();

		const second = await request.get(
			`${hostingDeploysPath(rootId)}?limit=1&cursor=${encodeURIComponent(page1.cursor!)}`
		);
		expect(second.status(), await second.text()).toBe(200);
		const page2 = (await second.json()) as { deploys: { id: string }[] };
		expect(page2.deploys).toHaveLength(1);
		// Keyset, not offset: the pages never overlap.
		expect(page2.deploys[0].id).not.toBe(page1.deploys[0].id);
	});

	test('a taken subdomain auto-numbers instead of failing', async ({ request }) => {
		const claim = await request.post(hostingClaimsPath(neighborId), {
			data: { app: appName }
		});
		expect(claim.status(), await claim.text()).toBe(201);
		const body = (await claim.json()) as { subdomain: string; created: boolean };
		expect(body.subdomain).toBe(`${appName}-2`);

		// The persisted row is reused verbatim afterwards - never re-derived.
		const again = await request.post(hostingClaimsPath(neighborId), {
			data: { app: appName }
		});
		expect(again.status(), await again.text()).toBe(200);
		expect(((await again.json()) as { subdomain: string }).subdomain).toBe(`${appName}-2`);
	});

	test('branch deploys serve at <app>-<branch>', async ({ request }) => {
		const branch = await request.post(projectBranchesPath(rootId), {
			data: { branch: 'stg' }
		});
		expect(branch.status(), await branch.text()).toBe(201);

		const deploy = await request.post(hostingDeployPath(`${rootId}--stg`, appName), deployBody());
		expect(deploy.status(), await deploy.text()).toBe(201);
		const body = (await deploy.json()) as { subdomain: string };
		// Single dash - `main` never appears in a URL, and dispatch never
		// parses this back apart; the claims table resolved it here.
		expect(body.subdomain).toBe(`${appName}-stg`);
	});

	test('demo projects get the 403 upsell, never a deploy', async ({ request }) => {
		const deploy = await request.post(
			hostingDeployPath('demo-abcdef123456', appName),
			deployBody()
		);
		expect(deploy.status(), await deploy.text()).toBe(403);
	});

	test('deleting an app erases it and frees the subdomain', async ({ request }) => {
		// Self-contained app so the shared appName claims stay untouched for
		// the release test below.
		const delApp = `del-${runId}`;
		const deployed = await request.post(hostingDeployPath(rootId, delApp), deployBody());
		expect(deployed.status(), await deployed.text()).toBe(201);

		const before = await request.get(hostingOverviewPath(rootId));
		expect(
			((await before.json()) as { apps: { name: string }[] }).apps.map((a) => a.name)
		).toContain(delApp);

		const deleted = await request.delete(hostingAppPath(rootId, delApp));
		expect(deleted.status(), await deleted.text()).toBe(200);
		const body = (await deleted.json()) as { deleted: boolean; subdomain: string };
		expect(body.deleted).toBe(true);
		expect(body.subdomain).toBe(delApp);

		// Gone from the agent - deploy history included.
		const after = await request.get(hostingOverviewPath(rootId));
		expect(
			((await after.json()) as { apps: { name: string }[] }).apps.map((a) => a.name)
		).not.toContain(delApp);

		// The subdomain is free again: a neighbor's dry claim gets the base name.
		const freed = await request.post(hostingClaimsPath(neighborId), {
			data: { app: delApp, dry: true }
		});
		expect(((await freed.json()) as { subdomain: string }).subdomain).toBe(delApp);

		// Deleting it again is a 404, not a 500 - the claim row is the gate.
		const again = await request.delete(hostingAppPath(rootId, delApp));
		expect(again.status(), await again.text()).toBe(404);
	});

	test('a claim that never deployed can still be deleted', async ({ request }) => {
		// Connecting a repository claims immediately; the agent only learns at
		// first deploy. Deleting must work on that claim-only state - the exact
		// shape that used to be stuck forever on the Hosting page.
		const ghost = `ghost-${runId}`;
		const claimed = await request.post(hostingClaimsPath(neighborId), { data: { app: ghost } });
		expect(claimed.status(), await claimed.text()).toBe(201);

		const deleted = await request.delete(hostingAppPath(neighborId, ghost));
		expect(deleted.status(), await deleted.text()).toBe(200);

		const freed = await request.post(hostingClaimsPath(neighborId), {
			data: { app: ghost, dry: true }
		});
		expect(((await freed.json()) as { subdomain: string }).subdomain).toBe(ghost);
	});

	test('deleting the project releases its claims', async ({ request }) => {
		const releaseProbe = `e2e-hostc-${runId}`;
		const created = await request.post('/api/registry/projects', {
			data: { id: releaseProbe, name: 'release probe' }
		});
		expect(created.status(), await created.text()).toBe(201);
		try {
			// Before the delete the base name belongs to rootId.
			const taken = await request.post(hostingClaimsPath(releaseProbe), {
				data: { app: appName, dry: true }
			});
			expect(((await taken.json()) as { subdomain: string }).subdomain).not.toBe(appName);

			const deleted = await request.delete(registryProjectPath(rootId));
			expect([200, 207], await deleted.text()).toContain(deleted.status());

			const freed = await request.post(hostingClaimsPath(releaseProbe), {
				data: { app: appName, dry: true }
			});
			expect(((await freed.json()) as { subdomain: string }).subdomain).toBe(appName);
		} finally {
			await request.delete(registryProjectPath(releaseProbe));
		}
	});
});

test.describe('stub serving', () => {
	// The serve path is only dialable on the local stack: the agent worker has
	// no public route on a deployed target.
	test.skip(!!process.env.BASE_URL, 'direct agent access needs the local stack');

	test('the wildcard host serves the stub page', async ({ playwright }) => {
		const agent = await playwright.request.newContext({ baseURL: 'http://localhost:8800' });
		try {
			const served = await agent.get('/', {
				headers: { 'x-cfbase-host': 'anything-at-all.cfbase.dev' }
			});
			expect(served.status(), await served.text()).toBe(200);
			expect(await served.text()).toContain('data-cfbase-stub="anything-at-all"');
		} finally {
			await agent.dispose();
		}
	});
});

test.describe('hosting guard', () => {
	// LOAD-BEARING: without this override the context inherits the operator
	// session and proves nothing.
	test.use({ storageState: { cookies: [], origins: [] } });

	test('every hosting surface requires an operator session', async ({ request }) => {
		const closed = [
			['GET', hostingOverviewPath(rootId)],
			['GET', hostingDeploysPath(rootId)],
			['POST', hostingClaimsPath(rootId)],
			['GET', hostingTokensPath(rootId)],
			['POST', hostingTokensPath(rootId)],
			['POST', hostingDeployPath(rootId, appName)],
			// App deletion is session-only by design: a deploy token that can
			// ship code must never be able to erase an app, and the guard's
			// token surface admits POST deploys/branches alone.
			['DELETE', hostingAppPath(rootId, appName)]
		] as const;
		for (const [method, path] of closed) {
			const response =
				method === 'GET'
					? await request.get(path)
					: method === 'DELETE'
						? await request.delete(path)
						: await request.post(path, { data: {} });
			expect(response.status(), `${method} ${path} must be closed`).toBe(401);
		}
	});
});
