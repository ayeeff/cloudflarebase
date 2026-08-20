import { expect, test } from '@playwright/test';
import {
	hostingDeployPath,
	hostingSecretPath,
	hostingSecretsPath,
	hostingVarsPath,
	registryProjectPath
} from './helpers';

/**
 * Stored app environments (runtime half): vars round-trip as a
 * replace-the-set store applied at deploy time, and secrets are write-through
 * names the console can list and delete. Everything runs against the stub -
 * which stores names and skips the Cloudflare calls - so the whole contract
 * is exercised on every run; the live settings-PATCH/DELETE shapes are pinned
 * by unit tests and the opt-in hosting-real spec.
 */

const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 12);
const projectId = `e2e-env-${runId}`;
const appName = `env-${runId}`;

const INDEX_HTML = {
	name: 'index.html',
	mimeType: 'text/html',
	buffer: Buffer.from('<h1>env spec</h1>')
};

test.describe('hosting app environment (stubbed)', () => {
	test.beforeAll(async ({ request }) => {
		const created = await request.post('/api/registry/projects', {
			data: { id: projectId, name: `Hosting env e2e ${runId}` }
		});
		expect(created.status(), await created.text()).toBe(201);
	});

	test.afterAll(async ({ request }) => {
		await request.delete(registryProjectPath(projectId));
	});

	test('vars round-trip, and the set is replaced - not merged', async ({ request }) => {
		// Vars need no apps row: a claim-only app can be configured before its
		// first deploy.
		const put = await request.put(hostingVarsPath(projectId, appName), {
			data: { vars: { ALPHA: 'one', BETA: 'two' } }
		});
		expect(put.status(), await put.text()).toBe(200);
		const putBody = (await put.json()) as {
			vars: { name: string; value: string }[];
			patched: boolean;
		};
		expect(putBody.vars.map((entry) => entry.name)).toEqual(['ALPHA', 'BETA']);
		// Stub mode has no live script to patch.
		expect(putBody.patched).toBe(false);

		const replaced = await request.put(hostingVarsPath(projectId, appName), {
			data: { vars: { BETA: 'changed', GAMMA: 'three' } }
		});
		expect(replaced.status(), await replaced.text()).toBe(200);

		const list = await request.get(hostingVarsPath(projectId, appName));
		expect(list.status(), await list.text()).toBe(200);
		const listBody = (await list.json()) as { vars: { name: string; value: string }[] };
		// ALPHA is gone (absent = deleted), BETA updated, GAMMA added.
		expect(listBody.vars.map((entry) => [entry.name, entry.value])).toEqual([
			['BETA', 'changed'],
			['GAMMA', 'three']
		]);
	});

	test('invalid names and multi-line values are refused', async ({ request }) => {
		for (const vars of [
			{ 'lower-case': 'x' },
			{ '9STARTS_WITH_DIGIT': 'x' },
			{ OK: 'line one\nline two' }
		]) {
			const put = await request.put(hostingVarsPath(projectId, appName), { data: { vars } });
			expect(put.status(), JSON.stringify(vars)).toBe(400);
		}
	});

	test('secrets require a deployed app', async ({ request }) => {
		const put = await request.post(hostingSecretsPath(projectId, appName), {
			data: { name: 'API_KEY', value: 'hunter2' }
		});
		expect(put.status(), await put.text()).toBe(404);
	});

	test('secrets store names in stub mode, list them, and delete idempotently', async ({
		request
	}) => {
		const deployed = await request.post(hostingDeployPath(projectId, appName), {
			multipart: { meta: JSON.stringify({}), 'asset:/index.html': INDEX_HTML }
		});
		expect(deployed.status(), await deployed.text()).toBe(201);

		// This 200 pins the 501 -> ok change: stub mode records the name so the
		// list/delete contract is exercisable locally.
		const put = await request.post(hostingSecretsPath(projectId, appName), {
			data: { name: 'API_KEY', value: 'hunter2' }
		});
		expect(put.status(), await put.text()).toBe(200);

		const list = await request.get(hostingSecretsPath(projectId, appName));
		expect(list.status(), await list.text()).toBe(200);
		const listBody = (await list.json()) as { secrets: { name: string }[] };
		expect(listBody.secrets.map((secret) => secret.name)).toEqual(['API_KEY']);
		// Names only - the value must never come back out.
		expect(JSON.stringify(listBody)).not.toContain('hunter2');

		const deleted = await request.delete(hostingSecretPath(projectId, appName, 'API_KEY'));
		expect(deleted.status(), await deleted.text()).toBe(200);

		const after = await request.get(hostingSecretsPath(projectId, appName));
		expect(((await after.json()) as { secrets: unknown[] }).secrets).toEqual([]);

		// Idempotent: deleting what is already gone is a 200, not an error.
		const again = await request.delete(hostingSecretPath(projectId, appName, 'API_KEY'));
		expect(again.status(), await again.text()).toBe(200);
	});

	test('deploys apply stored vars over CLI meta.vars', async ({ request }) => {
		const put = await request.put(hostingVarsPath(projectId, appName), {
			data: { vars: { SHARED: 'console-wins' } }
		});
		expect(put.status(), await put.text()).toBe(200);

		// The stub records the deploy without uploading, so the merge itself is
		// pinned by unit tests; here the contract is that a deploy with
		// conflicting meta.vars still succeeds and the stored value survives.
		const deployed = await request.post(hostingDeployPath(projectId, appName), {
			multipart: {
				meta: JSON.stringify({ vars: { SHARED: 'cli-loses', CLI_ONLY: 'kept' } }),
				'asset:/index.html': INDEX_HTML
			}
		});
		expect(deployed.status(), await deployed.text()).toBe(201);

		const list = await request.get(hostingVarsPath(projectId, appName));
		const listBody = (await list.json()) as { vars: { name: string; value: string }[] };
		expect(listBody.vars).toEqual([
			expect.objectContaining({ name: 'SHARED', value: 'console-wins' })
		]);
	});

	test('deleting the app erases its environment', async ({ request }) => {
		const deleted = await request.delete(`/api/projects/${projectId}/hosting/apps/${appName}`);
		expect(deleted.status(), await deleted.text()).toBe(200);

		const vars = await request.get(hostingVarsPath(projectId, appName));
		expect(((await vars.json()) as { vars: unknown[] }).vars).toEqual([]);
		const secrets = await request.get(hostingSecretsPath(projectId, appName));
		expect(((await secrets.json()) as { secrets: unknown[] }).secrets).toEqual([]);
	});
});

test.describe('hosting env guard', () => {
	// LOAD-BEARING: without this override the context inherits the operator
	// session and proves nothing.
	test.use({ storageState: { cookies: [], origins: [] } });

	test('every environment surface requires an operator session', async ({ request }) => {
		const closed = [
			['GET', hostingVarsPath(projectId, appName)],
			['PUT', hostingVarsPath(projectId, appName)],
			['GET', hostingSecretsPath(projectId, appName)],
			['POST', hostingSecretsPath(projectId, appName)],
			['DELETE', hostingSecretPath(projectId, appName, 'API_KEY')]
		] as const;
		for (const [method, path] of closed) {
			const response = await request.fetch(path, {
				method,
				data: method === 'GET' || method === 'DELETE' ? undefined : {}
			});
			expect(response.status(), `${method} ${path} must be closed`).toBe(401);
		}
	});

	test('the direct agent hop is closed too', async ({ request }) => {
		// The console guard has to cover the proxy AND the passthrough, or it
		// covers neither.
		const direct = await request.get(`/agents/hosting-agent/${projectId}/apps/${appName}/vars`);
		expect(direct.status(), await direct.text()).toBe(401);
	});
});
