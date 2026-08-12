import { expect, test } from '@playwright/test';
import { hostingDeployPath, hostingOverviewPath, registryProjectPath } from './helpers';

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
 */

const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 12);
const rootId = `e2e-real-${runId}`;
const appName = `real-${runId}`;

test.describe('real dispatch-namespace upload', () => {
	test.skip(
		!process.env.RUN_HOSTING_E2E,
		'set RUN_HOSTING_E2E=1 (against a WfP-configured stack) to test the real upload'
	);

	test('a deploy lands live in the namespace', async ({ request }) => {
		const created = await request.post('/api/registry/projects', {
			data: { id: rootId, name: `Real hosting e2e ${rootId}` }
		});
		expect(created.status(), await created.text()).toBe(201);
		try {
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
		} finally {
			// Deleting the project also erases the uploaded script by tag.
			await request.delete(registryProjectPath(rootId));
		}
	});
});
