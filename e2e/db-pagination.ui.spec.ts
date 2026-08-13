import { expect, test, type Page } from '@playwright/test';
import { dbAdminCollectionPath, dbAdminImportPath, ensureProject } from './helpers';

/**
 * The document browser pages instead of silently truncating. Its own project so
 * the row churn never touches counts other specs assert exactly.
 */
const PAGE_PROJECT = 'e2e-db-page';
const TOTAL = 60;
const PAGE_SIZE = 50;

async function gotoCollection(page: Page, collection: string) {
	await page.goto(`/dashboard/${PAGE_PROJECT}/db?collection=${collection}`);
	await expect(page.getByTestId('db-page')).toHaveAttribute('data-hydrated', 'true');
}

test.describe('database pagination (frontend)', () => {
	// Operator surfaces answer only for registered ids.
	test.beforeAll(async ({ request }) => {
		await ensureProject(request, PAGE_PROJECT);
	});

	test('the document browser pages through a collection larger than one page', async ({
		page,
		request
	}) => {
		const collection = `paged${Date.now().toString(36)}`;
		const provision = await request.put(dbAdminCollectionPath(PAGE_PROJECT, collection), {
			data: { readAccess: 'public', writeAccess: 'public', replication: 'off' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		// Import rather than 60 round trips. Ids are zero-padded so the agent's
		// default id order is the same order the assertions read in.
		const ndjson = Array.from({ length: TOTAL }, (_, index) =>
			JSON.stringify({ id: `doc-${String(index).padStart(3, '0')}`, data: { rank: index } })
		).join('\n');
		const imported = await request.post(dbAdminImportPath(PAGE_PROJECT, collection), {
			headers: { 'content-type': 'application/x-ndjson' },
			data: ndjson
		});
		expect(imported.ok(), await imported.text()).toBeTruthy();

		await gotoCollection(page, collection);

		// First page: the range reads against the registry's real total, not the
		// number of rows on screen.
		const range = page.getByTestId('db-docs-range');
		await expect(range).toHaveText(`1–${PAGE_SIZE} of ${TOTAL}`);
		await expect(page.getByTestId('db-docs-prev')).toBeDisabled();
		await expect(page.getByTestId('db-doc-doc-000')).toBeVisible();

		// Last page: partial, and Next retires.
		await page.getByTestId('db-docs-next').click();
		await expect(range).toHaveText(`${PAGE_SIZE + 1}–${TOTAL} of ${TOTAL}`);
		await expect(page.getByTestId('db-docs-next')).toBeDisabled();
		await expect(page.getByTestId('db-doc-doc-059')).toBeVisible();
		await expect(page.getByTestId('db-doc-doc-000')).toHaveCount(0);

		// Back is a real walk, not a reset: the first page returns intact and
		// survives the 5s live refresh landing on top of it.
		await page.getByTestId('db-docs-prev').click();
		await expect(range).toHaveText(`1–${PAGE_SIZE} of ${TOTAL}`);
		await expect(page.getByTestId('db-doc-doc-000')).toBeVisible();
	});
});
