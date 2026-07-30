import { expect, test, type Page } from '@playwright/test';

/**
 * Database tab (frontend). Uses its own project so collection churn never
 * touches the seed's exactly-asserted counts, and unique collection names so
 * reused local stacks stay idempotent.
 */
const DB_UI_PROJECT = 'e2e-db-ui';

function uniqueCollection(prefix: string): string {
	return `${prefix}${Date.now().toString(36)}`;
}

async function gotoDbPage(page: Page, projectId: string) {
	await page.goto(`/dashboard/${projectId}/db`);
	await expect(page.getByTestId('db-page')).toHaveAttribute('data-hydrated', 'true');
}

async function createCollection(page: Page, name: string) {
	await page.locator('#new-collection-name').fill(name);
	await page.getByTestId('db-create-collection').getByRole('button', { name: 'Create' }).click();
	await expect(page.getByTestId(`db-collection-${name}`)).toBeVisible();
}

test.describe('database page (frontend)', () => {
	test('sidebar and overview expose the database surfaces', async ({ page }) => {
		await page.goto(`/dashboard/${DB_UI_PROJECT}`);
		await expect(page.getByTestId('product-db')).toBeVisible();

		await page.getByTestId('nav-db').click();
		await expect(page.getByTestId('db-page')).toHaveAttribute('data-hydrated', 'true');
		// A virgin project renders the empty state, not the table - the create
		// form is the surface that is always there.
		await expect(page.getByTestId('db-create-collection')).toBeVisible();
	});

	test('connects to the db agent for live updates', async ({ page }) => {
		await gotoDbPage(page, DB_UI_PROJECT);

		// On the local prod-mirroring stack the WebSocket passthrough is verified
		// to work, so demand true realtime; remote stacks may fall back to polling.
		const expected = process.env.BASE_URL ? /realtime|polling/ : 'realtime';
		await expect(page.getByTestId('connection-status')).toHaveText(expected);
	});

	test('creating a collection and a document updates the browser without reload', async ({
		page
	}) => {
		const collection = uniqueCollection('c');
		await gotoDbPage(page, DB_UI_PROJECT);
		await createCollection(page, collection);

		await page.getByTestId(`db-collection-${collection}`).click();
		await page.getByTestId('db-add-document').click();

		const editor = page.getByTestId('db-doc-editor');
		await editor.getByPlaceholder('auto-generated').fill('ui-doc-1');
		await editor.locator('textarea').fill('{"text":"from the ui","done":false}');
		await editor.getByRole('button', { name: 'Save document' }).click();

		await expect(page.getByTestId('db-documents-table').getByText('ui-doc-1')).toBeVisible();

		// The child reports its count (debounced ~2s) and state sync moves the
		// stat without a reload.
		await expect(page.getByTestId('db-stat-documents').getByTestId('stat-value')).not.toHaveText(
			'0',
			{ timeout: 15_000 }
		);
	});

	test('malformed JSON in the document editor surfaces inline, not as a crash', async ({
		page
	}) => {
		const collection = uniqueCollection('e');
		await gotoDbPage(page, DB_UI_PROJECT);
		await createCollection(page, collection);

		await page.getByTestId(`db-collection-${collection}`).click();
		await page.getByTestId('db-add-document').click();

		const editor = page.getByTestId('db-doc-editor');
		await editor.locator('textarea').fill('{not json');
		await editor.getByRole('button', { name: 'Save document' }).click();
		await expect(page.getByTestId('db-doc-error')).toBeVisible();
	});

	test('access mode changes apply and survive a reload', async ({ page }) => {
		const collection = uniqueCollection('a');
		await gotoDbPage(page, DB_UI_PROJECT);
		await createCollection(page, collection);

		await page.getByRole('tab', { name: 'Access' }).click();
		const row = page.getByTestId(`db-access-${collection}`);
		// The create form defaults read access to `public`, so pick a DIFFERENT
		// mode - Apply only enables once an actual edit is pending.
		await row.getByLabel(`Read access for ${collection}`).click();
		await page.getByRole('option', { name: 'auth' }).click();
		await row.getByRole('button', { name: 'Apply' }).click();
		await expect(row.getByText('Saved')).toBeVisible();

		await page.reload();
		await expect(page.getByTestId('db-page')).toHaveAttribute('data-hydrated', 'true');
		await page.getByRole('tab', { name: 'Access' }).click();
		await expect(
			page.getByTestId(`db-access-${collection}`).getByLabel(`Read access for ${collection}`)
		).toHaveText('auth');
	});

	test('integration snippets address this project', async ({ page }) => {
		await gotoDbPage(page, DB_UI_PROJECT);
		await page.getByRole('tab', { name: 'Integration' }).click();

		const integration = page.getByTestId('db-integration');
		await expect(integration).toContainText(`/api/projects/${DB_UI_PROJECT}/db`);
		await expect(integration).toContainText('@cloudflarebase/db/client');
		await expect(integration).toContainText(`/agents/db-agent/${DB_UI_PROJECT}/collections`);
	});
});
