import { expect, test, type Playwright } from '@playwright/test';
import { dbAdminCollectionPath, dbOverviewPath, overviewPath } from './helpers';

/**
 * The demo claim (docs/managed-service-design.md): an anonymous visitor's
 * demo project becomes an owned, registered project the instant a signed-in
 * operator claims it - same id, same data, no copying. The registry decides,
 * never the string shape: an unclaimed demo keeps its anonymous behaviour,
 * a claimed one requires ownership on every surface.
 *
 * Fresh random ids per run: claims are permanent registry rows, so a fixed
 * id would collide on locally reused stacks.
 */
function freshDemoId(): string {
	return `demo-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

/** Truly anonymous context. The empty storageState is LOAD-BEARING: inside
 * the test runner every new context inherits the project's `use` options,
 * operator session included, unless overridden. */
function anonContext(playwright: Playwright, baseURL: string | undefined) {
	return playwright.request.newContext({
		baseURL,
		extraHTTPHeaders: { origin: baseURL! },
		storageState: { cookies: [], origins: [] }
	});
}

test.describe('demo claim', () => {
	test('claiming ends anonymous access and registers ownership', async ({
		baseURL,
		playwright,
		request
	}) => {
		const demoId = freshDemoId();
		const anon = await anonContext(playwright, baseURL);
		try {
			// Unclaimed: the anonymous visitor drives the project - this is what
			// materializes the agents' Durable Objects, like a real demo session.
			const provision = await anon.put(dbAdminCollectionPath(demoId, 'notes'), {
				data: { readAccess: 'public', writeAccess: 'public' }
			});
			expect(provision.ok(), await provision.text()).toBeTruthy();
			const anonBefore = await anon.get(overviewPath(demoId));
			expect(anonBefore.ok(), 'unclaimed demos stay anonymous').toBeTruthy();

			// Ordinary project creation refuses demo-shaped ids: a row minted
			// without the claim fan-out would leave the TTL armed.
			const refused = await request.post('/api/registry/projects', {
				data: { id: demoId, name: 'not like this' }
			});
			expect(refused.status(), await refused.text()).toBe(400);

			// The claim: registry row under the claimer's org, then agent fan-out.
			const claim = await request.post(`/api/registry/projects/${demoId}/claim`, {
				data: { name: 'Kept demo' }
			});
			expect([201, 207], await claim.text()).toContain(claim.status());
			const claimed = await claim.json();
			expect(claimed.project.id).toBe(demoId);
			expect(claimed.project.orgId, 'claims are org-owned').toBeTruthy();

			try {
				// First-claim-wins by primary-key atomicity.
				const second = await request.post(`/api/registry/projects/${demoId}/claim`, {
					data: {}
				});
				expect(second.status(), await second.text()).toBe(409);

				// Anonymous access ended the instant the row appeared...
				const anonAfter = await anon.get(dbOverviewPath(demoId));
				expect(anonAfter.status(), 'claimed demos are no longer anonymous').toBe(401);
				const anonAuth = await anon.get(overviewPath(demoId));
				expect(anonAuth.status()).toBe(401);

				// ...while the owner keeps working through the same surfaces, and
				// the project now lists like any other, org-stamped.
				const owner = await request.get(dbOverviewPath(demoId));
				expect(owner.ok(), await owner.text()).toBeTruthy();
				const list = await (await request.get('/api/registry/projects')).json();
				const row = list.projects.find((entry: { id: string }) => entry.id === demoId);
				expect(row?.orgId).toBe(claimed.project.orgId);
			} finally {
				// Cleanup keeps reused stacks under the project cap; deletion also
				// erases the agents' data via the ordinary fan-out.
				const del = await request.delete(`/api/registry/projects/${demoId}`);
				expect(del.ok(), await del.text()).toBeTruthy();
			}
		} finally {
			await anon.dispose();
		}
	});

	test('a claim without a session is refused', async ({ baseURL, playwright }) => {
		const anon = await anonContext(playwright, baseURL);
		try {
			// The guard deliberately lets anonymous traffic reach unregistered
			// demo ids, so the claim endpoint must demand the session itself.
			const claim = await anon.post(`/api/registry/projects/${freshDemoId()}/claim`, {
				data: {}
			});
			expect(claim.status(), await claim.text()).toBe(401);
		} finally {
			await anon.dispose();
		}
	});

	test('unclaimed demos keep their anonymous behaviour', async ({ baseURL, playwright }) => {
		const anon = await anonContext(playwright, baseURL);
		try {
			const overview = await anon.get(overviewPath(freshDemoId()));
			expect(overview.ok(), await overview.text()).toBeTruthy();
		} finally {
			await anon.dispose();
		}
	});
});
