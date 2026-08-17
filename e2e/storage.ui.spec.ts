import { expect, test } from '@playwright/test';
import { ensureProject, storageAdminObjectPath, storageBucketPath } from './helpers';

/**
 * The storage console pages (docs/storage-agent-plan.md, "Console pages").
 *
 * Files is the table-editor shape: a permanent bucket rail beside a full-bleed
 * browser whose breadcrumb walks the DELIMITED listing - folders being virtual,
 * derived at read time from flat keys, so descending one is a prefix change and
 * nothing is ever created.
 */

const UI_PROJECT = 'e2e-storage-ui';
const BUCKET = 'spec-ui';

test.describe('storage console', () => {
	// The chromium project sets no default Origin (only the api one does), and
	// SvelteKit's CSRF check forbids form content types - `text/plain` included
	// - on an origin-less request. Seeding here therefore sends one explicitly;
	// a real browser always would.
	const seedHeaders = (baseURL: string | undefined) => ({
		origin: baseURL ?? process.env.BASE_URL ?? 'http://localhost:8797',
		'content-type': 'text/plain'
	});

	test.beforeAll(async ({ request, baseURL }) => {
		await ensureProject(request, UI_PROJECT);
		const bucket = await request.put(storageBucketPath(UI_PROJECT, BUCKET), {
			data: {},
			headers: { origin: baseURL ?? 'http://localhost:8797' }
		});
		expect([200, 201], await bucket.text()).toContain(bucket.status());
		for (const key of ['readme.txt', 'photos/one.txt', 'photos/two.txt', 'photos/raw/three.txt']) {
			const put = await request.put(storageAdminObjectPath(UI_PROJECT, BUCKET, key), {
				data: `bytes for ${key}`,
				headers: seedHeaders(baseURL)
			});
			expect(put.ok(), await put.text()).toBeTruthy();
		}
	});

	test('the sidebar shows Storage now that it ships console pages', async ({ page }) => {
		await page.goto(`/dashboard/${UI_PROJECT}/storage`);
		// The registry emits the section from the manifest, so this is also the
		// check that `console.pages` is wired.
		await expect(page.getByTestId('nav-storage')).toBeVisible();
		// And it must no longer be advertised as unbuilt.
		await expect(page.getByTestId('nav-section-coming-soon')).toHaveCount(0);
	});

	test('the browser lists folders and files, and descends', async ({ page }) => {
		await page.goto(`/dashboard/${UI_PROJECT}/storage`);
		await expect(page.getByTestId('bucket-rail')).toBeVisible();
		await expect(page.getByTestId(`bucket-${BUCKET}`)).toBeVisible();

		// Root: one file, one folder - never the whole flat subtree.
		const rows = page.getByTestId('file-rows');
		await expect(rows.getByTestId('folder-row')).toHaveCount(1);
		await expect(rows.getByTestId('object-row')).toHaveCount(1);
		await expect(rows).toContainText('readme.txt');
		await expect(rows).toContainText('photos/');

		// Descend: the breadcrumb grows and the listing re-collapses a level in.
		await rows.getByTestId('folder-row').first().click();
		await expect(page.getByTestId('breadcrumb')).toContainText('photos');
		await expect(rows.getByTestId('object-row')).toHaveCount(2);
		await expect(rows.getByTestId('folder-row')).toHaveCount(1);

		// And back up via the breadcrumb.
		await page.getByTestId('breadcrumb').getByText(BUCKET).click();
		await expect(rows).toContainText('readme.txt');
	});

	test('an object opens a preview sheet that can mint a signed URL', async ({ page }) => {
		await page.goto(`/dashboard/${UI_PROJECT}/storage`);
		await page.getByTestId('file-rows').getByTestId('object-row').first().click();

		const sheet = page.getByTestId('object-sheet');
		await expect(sheet).toBeVisible();
		await expect(sheet).toContainText('readme.txt');

		await sheet.getByTestId('sign-url').click();
		const signed = sheet.getByTestId('signed-url');
		await expect(signed).toBeVisible();
		await expect(signed).toContainText('sig=');
	});

	test('deleting an object is confirmed, never a bare click', async ({
		page,
		request,
		baseURL
	}) => {
		const key = 'disposable.txt';
		await request.put(storageAdminObjectPath(UI_PROJECT, BUCKET, key), {
			data: 'delete me',
			headers: seedHeaders(baseURL)
		});
		await page.goto(`/dashboard/${UI_PROJECT}/storage`);

		await page.getByTestId('file-rows').getByText(key).click();
		await page.getByTestId('object-sheet').getByTestId('delete-object').click();
		// An AlertDialog stands between the click and the deletion.
		await expect(page.getByTestId('confirm-delete')).toBeVisible();
		await page.getByTestId('confirm-delete').click();

		await expect(page.getByTestId('file-rows')).not.toContainText(key);
	});

	test('the Access page states each bucket config in plain words', async ({ page }) => {
		await page.goto(`/dashboard/${UI_PROJECT}/storage/access`);
		const card = page.getByTestId(`access-card-${BUCKET}`);
		await expect(card).toBeVisible();
		// The default is auth/auth, and the sentence has to say so - the whole
		// point of the plain-English rendering.
		await expect(card).toContainText('signed-in');
		await expect(card).toContainText('not public');
	});

	test('the Integration page shows the client snippet', async ({ page }) => {
		await page.goto(`/dashboard/${UI_PROJECT}/storage/integration`);
		const panel = page.getByTestId('storage-integration');
		await expect(panel).toContainText('@cloudflarebase/storage/client');
		await expect(panel).toContainText('createSignedUrl');
	});

	test('an unknown tool page is a 404, never an empty workspace', async ({ page }) => {
		const response = await page.goto(`/dashboard/${UI_PROJECT}/storage/nonsense`);
		expect(response?.status()).toBe(404);
	});
});
