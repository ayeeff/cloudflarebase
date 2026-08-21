import { expect, test, type Page } from '@playwright/test';
import { CONSOLE_STORAGE_STATE, hostingDeployPath, registryProjectPath } from './helpers';

/**
 * Hosting pages (frontend): the hub's app list, the per-app page's URL tabs,
 * and the variables-and-secrets editor - the first UI coverage hosting has.
 * Uses a per-run project so reused local stacks never collide on permanent
 * subdomain claims, and serial mode because the tests walk one app's life.
 */

const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 12);
const projectId = `e2e-hostui-${runId}`;
const appName = `ui-${runId}`;

async function gotoHosting(page: Page) {
	await page.goto(`/dashboard/${projectId}/hosting`);
	await expect(page.getByTestId('hosting-page')).toHaveAttribute('data-hydrated', 'true');
}

async function gotoApp(page: Page, tab = '') {
	await page.goto(`/dashboard/${projectId}/hosting/apps/${appName}${tab ? `/${tab}` : ''}`);
	await expect(page.getByTestId('hosting-app-page')).toHaveAttribute('data-hydrated', 'true');
}

test.describe('hosting pages (frontend)', () => {
	test.describe.configure({ mode: 'serial' });

	test.beforeAll(async ({ playwright, baseURL }) => {
		// The chromium project's request fixture sends no Origin header, and the
		// multipart deploy would trip the CSRF check without one.
		const api = await playwright.request.newContext({
			baseURL,
			extraHTTPHeaders: { origin: baseURL ?? '' },
			storageState: CONSOLE_STORAGE_STATE
		});
		try {
			const created = await api.post('/api/registry/projects', {
				data: { id: projectId, name: `Hosting UI e2e ${runId}` }
			});
			expect(created.status(), await created.text()).toBe(201);
			// A deployed app: the detail page's secrets editor needs one (secrets
			// attach to the deployed script).
			const deployed = await api.post(hostingDeployPath(projectId, appName), {
				multipart: {
					meta: JSON.stringify({}),
					'asset:/index.html': {
						name: 'index.html',
						mimeType: 'text/html',
						buffer: Buffer.from('<h1>ui spec</h1>')
					}
				}
			});
			expect(deployed.status(), await deployed.text()).toBe(201);
		} finally {
			await api.dispose();
		}
	});

	test.afterAll(async ({ request }) => {
		await request.delete(registryProjectPath(projectId));
	});

	test('the hub lists the app and opens its page', async ({ page }) => {
		await gotoHosting(page);
		await page.getByTestId(`open-app-${appName}`).click();
		await expect(page.getByTestId('hosting-app-page')).toHaveAttribute('data-hydrated', 'true');
		await expect(page).toHaveURL(new RegExp(`/hosting/apps/${appName}$`));
		await expect(page.getByTestId('app-stat-deploys').getByTestId('stat-value')).toHaveText('1');
	});

	test('tabs are URL-addressed sibling routes', async ({ page }) => {
		await gotoApp(page);
		await page.getByTestId('tab-app-deployments').click();
		await expect(page).toHaveURL(new RegExp(`/hosting/apps/${appName}/deployments$`));
		await expect(page.getByTestId('hosting-deploys-range')).toHaveText('1–1 of 1');

		await page.getByTestId('tab-app-analytics').click();
		await expect(page).toHaveURL(new RegExp(`/hosting/apps/${appName}/analytics$`));
		// The test stack reads the local D1 stand-in: the chart renders (zeroed
		// is fine), never the write-only upsell.
		await expect(page.getByTestId('hosting-analytics-chart')).toBeVisible();

		await page.getByTestId('tab-app-settings').click();
		await expect(page).toHaveURL(new RegExp(`/hosting/apps/${appName}/settings$`));
		await expect(page.getByTestId('hosting-vars-card')).toBeVisible();
	});

	test('runtime vars round-trip through the editor', async ({ page }) => {
		await gotoApp(page, 'settings');

		await page.getByTestId('hosting-vars-add').click();
		await page.getByTestId('hosting-vars-name-0').fill('API_BASE');
		await page.getByTestId('hosting-vars-value-0').fill('https://api.example');
		await page.getByTestId('hosting-vars-save').click();
		await expect(page.getByTestId('hosting-vars-feedback')).toHaveText('Saved.');

		// Server truth, not optimistic state: a reload renders the stored row.
		await gotoApp(page, 'settings');
		await expect(page.getByTestId('hosting-vars-name-0')).toHaveValue('API_BASE');
		await expect(page.getByTestId('hosting-vars-value-0')).toHaveValue('https://api.example');
	});

	test('secrets are write-only rows', async ({ page }) => {
		await gotoApp(page, 'settings');

		// Row 0 is the stored var; add row 1 and flip it to Secret.
		await page.getByTestId('hosting-vars-add').click();
		await page.getByTestId('hosting-vars-type-1').click();
		await page.getByRole('option', { name: 'Secret' }).click();
		await page.getByTestId('hosting-vars-name-1').fill('API_KEY');
		await page.getByTestId('hosting-vars-value-1').fill('hunter2');
		await page.getByTestId('hosting-vars-save').click();
		await expect(page.getByTestId('hosting-vars-feedback')).toHaveText('Saved.');

		// Reloaded, the secret is a write-only row: named, but the value is
		// gone for good - only the placeholder admits it exists.
		await gotoApp(page, 'settings');
		await expect(page.getByTestId('hosting-vars-name-1')).toHaveValue('API_KEY');
		await expect(page.getByTestId('hosting-vars-value-1')).toHaveValue('');
		await expect(page.getByTestId('hosting-vars-value-1')).toHaveAttribute(
			'placeholder',
			/Value encrypted/
		);

		// Removing the row deletes the secret on Save.
		await page.getByTestId('hosting-vars-remove-1').click();
		await page.getByTestId('hosting-vars-save').click();
		await expect(page.getByTestId('hosting-vars-feedback')).toHaveText('Saved.');
		await gotoApp(page, 'settings');
		await expect(page.getByTestId('hosting-vars-name-1')).toHaveCount(0);
	});

	test('the danger zone deletes the app with a typed confirm', async ({ page }) => {
		await gotoApp(page, 'settings');
		await page.getByTestId(`delete-app-${appName}`).click();

		const submit = page.getByTestId('confirm-delete-app');
		await expect(submit).toBeDisabled();
		await page.getByTestId('delete-app-confirm').fill(appName);
		await submit.click();

		// Deleting navigates back to the hub, where the app is gone.
		await expect(page.getByTestId('hosting-page')).toHaveAttribute('data-hydrated', 'true');
		await expect(page.getByTestId(`open-app-${appName}`)).toHaveCount(0);
	});
});
