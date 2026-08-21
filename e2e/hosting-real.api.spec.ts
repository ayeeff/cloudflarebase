import { expect, test } from '@playwright/test';
import {
	hostingDeployPath,
	hostingOverviewPath,
	hostingSecretPath,
	hostingSecretsPath,
	hostingVarsPath,
	registryProjectPath
} from './helpers';

/**
 * Real Workers for Platforms upload - opt-in, the RUN_AI_E2E precedent.
 *
 * Point BASE_URL at a stack whose hosting agent has a real dispatch
 * namespace (the -preview namespace on cloudflarebase.com's account) and set
 * RUN_HOSTING_E2E=1: this deploys a tiny asset app for real and expects a
 * `live` deploy, which exercises the asset upload session, the salted
 * manifest hashing, and the script PUT against the actual Cloudflare API.
 * Serving is NOT asserted here - preview has no cfbase.dev route, so the
 * wildcard only exists in production.
 *
 * This spec is ALSO the live verification of two API shapes nothing else
 * proves (the stub skips both):
 * - the settings PATCH that replaces a script's plain_text set works on an
 *   assets-only script (`PUT vars` answering `patched: true`), and
 * - the per-script secrets DELETE endpoint
 *   (`.../scripts/{script}/secrets/{name}`) exists and answers.
 * Do not trust the console's live-edit or secret-delete buttons on a real
 * install until this has passed against the target account.
 */

const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 12);
const rootId = `e2e-real-${runId}`;
const appName = `real-${runId}`;

test.describe('real dispatch-namespace upload', () => {
	test.describe.configure({ mode: 'serial' });
	test.skip(
		!process.env.RUN_HOSTING_E2E,
		'set RUN_HOSTING_E2E=1 (against a WfP-configured stack) to test the real upload'
	);

	test.beforeAll(async ({ request }) => {
		const created = await request.post('/api/registry/projects', {
			data: { id: rootId, name: `Real hosting e2e ${rootId}` }
		});
		expect(created.status(), await created.text()).toBe(201);
	});

	test.afterAll(async ({ request }) => {
		// Deleting the project also erases the uploaded script by tag.
		await request.delete(registryProjectPath(rootId));
	});

	test('a deploy lands live in the namespace', async ({ request }) => {
		const before = await request.get(hostingOverviewPath(rootId));
		expect(before.status(), await before.text()).toBe(200);
		const overview = (await before.json()) as { stub: boolean; configured: boolean };
		expect(
			overview.stub,
			'the target stack is in HOSTING_STUB mode - this spec needs real credentials'
		).toBe(false);
		expect(overview.configured, 'the hosting agent is missing its Cloudflare API config').toBe(
			true
		);

		const deploy = await request.post(hostingDeployPath(rootId, appName), {
			multipart: {
				meta: JSON.stringify({}),
				'asset:/index.html': {
					name: 'index.html',
					mimeType: 'text/html',
					buffer: Buffer.from(`<h1>cloudflarebase real e2e ${runId}</h1>`)
				}
			}
		});
		expect(deploy.status(), await deploy.text()).toBe(201);
		const body = (await deploy.json()) as { deploy: { status: string }; subdomain: string };
		expect(body.deploy.status).toBe('live');
		expect(body.subdomain).toBe(appName);
	});

	test('a var edit patches the live assets-only script', async ({ request }) => {
		// RISK GATE: proves the settings PATCH (bindings replacement with
		// keep_bindings [secret_text, assets]) is accepted for a script that
		// has no main module.
		const put = await request.put(hostingVarsPath(rootId, appName), {
			data: { vars: { REAL_E2E: runId } }
		});
		expect(put.status(), await put.text()).toBe(200);
		const body = (await put.json()) as { patched: boolean; warning?: string };
		expect(body.warning ?? '').toBe('');
		expect(body.patched, 'the live settings PATCH must succeed on an assets-only script').toBe(
			true
		);
	});

	test('secrets set, list, survive a redeploy, and DELETE for real', async ({ request }) => {
		const set = await request.post(hostingSecretsPath(rootId, appName), {
			data: { name: 'REAL_SECRET', value: `real-${runId}` }
		});
		expect(set.status(), await set.text()).toBe(200);

		const listed = await request.get(hostingSecretsPath(rootId, appName));
		expect(
			((await listed.json()) as { secrets: { name: string }[] }).secrets.map((s) => s.name)
		).toContain('REAL_SECRET');

		// keep_bindings holds the secret across a redeploy.
		const redeploy = await request.post(hostingDeployPath(rootId, appName), {
			multipart: {
				meta: JSON.stringify({}),
				'asset:/index.html': {
					name: 'index.html',
					mimeType: 'text/html',
					buffer: Buffer.from(`<h1>redeploy ${runId}</h1>`)
				}
			}
		});
		expect(redeploy.status(), await redeploy.text()).toBe(201);
		const after = await request.get(hostingSecretsPath(rootId, appName));
		expect(
			((await after.json()) as { secrets: { name: string }[] }).secrets.map((s) => s.name)
		).toContain('REAL_SECRET');

		// RISK GATE: THE live verification of the WfP per-script secrets DELETE
		// endpoint - the console's delete button is not "done" until this passes.
		const deleted = await request.delete(hostingSecretPath(rootId, appName, 'REAL_SECRET'));
		expect(deleted.status(), await deleted.text()).toBe(200);
		const gone = await request.get(hostingSecretsPath(rootId, appName));
		expect(
			((await gone.json()) as { secrets: { name: string }[] }).secrets.map((s) => s.name)
		).not.toContain('REAL_SECRET');
	});
});
