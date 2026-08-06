import { expect, request as playwrightRequest, test } from '@playwright/test';

/**
 * Smoke tests against the db-agent worker directly (not through the web
 * worker). Only meaningful on the local stack - the agent has no public route
 * in production - so this file skips itself when BASE_URL targets a remote
 * stack, mirroring the auth agent's direct smoke test.
 */
const AGENT_URL = process.env.DB_AGENT_URL ?? 'http://localhost:8799';

test.describe('db-agent worker (direct)', () => {
	test.skip(!!process.env.BASE_URL, 'agent worker is not directly reachable on remote stacks');

	test('health endpoint responds', async () => {
		const agent = await playwrightRequest.newContext({ baseURL: AGENT_URL });
		const response = await agent.get('/health');
		expect(response.ok()).toBe(true);
		expect(await response.json()).toEqual({ service: 'db-agent', status: 'ok' });
		await agent.dispose();
	});

	test('unknown routes return 404', async () => {
		const agent = await playwrightRequest.newContext({ baseURL: AGENT_URL });
		const response = await agent.get('/definitely-not-a-route');
		expect(response.status()).toBe(404);
		await agent.dispose();
	});

	test('validates direct agent inputs without relying on the web worker', async () => {
		const agent = await playwrightRequest.newContext({ baseURL: AGENT_URL });
		const base = '/agents/db-agent/e2e-db-direct';

		// Invalid project id - refused by the worker entrypoint before any
		// Durable Object is touched.
		const invalidProject = await agent.get(
			'/agents/db-agent/Not_A_Valid_Project/collections/notes'
		);
		expect(invalidProject.status()).toBe(400);

		// Collection names become Durable Object name suffixes; anything outside
		// the tame pattern is refused at the same boundary.
		const invalidCollection = await agent.get(`${base}/collections/Not-A-Valid-Name`);
		expect(invalidCollection.status()).toBe(400);

		// A public collection, provisioned through the agent's own admin route,
		// pins that body validation is agent-side (an auth-mode collection would
		// 401 before the query parser ever ran).
		const provision = await agent.put(`${base}/admin/collections/probe`, {
			data: { readAccess: 'public', writeAccess: 'public', replication: 'off' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		const malformedQuery = await agent.post(`${base}/collections/probe/query`, {
			data: { where: 'not an array' }
		});
		expect(malformedQuery.status()).toBe(400);

		await agent.dispose();
	});
});
