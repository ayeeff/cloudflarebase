import { expect, test, type Page } from '@playwright/test';

/**
 * The header branch switcher and the grouped projects overview
 * (docs/branches-design.md). The e2e seed projects are deliberately not
 * registry rows, so the first test pins that the control hides there; the
 * rest work a registered root end to end. Tests in this file are sequential
 * and share the run's root project.
 */

/** Unique per run so a locally reused stack never collides. */
const ROOT =
	`uibr-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`.slice(0, 20);
const BRANCH = 'stg';

async function gotoProject(page: Page, projectId: string) {
	await page.goto(`/dashboard/${projectId}`);
	// The dropdown only answers clicks after hydration.
	await expect(page.getByTestId('branch-switcher')).toHaveAttribute('data-hydrated', 'true');
}

test.describe('branch switcher (frontend)', () => {
	test('stays hidden on projects the registry does not know', async ({ page }) => {
		await page.goto('/dashboard/e2e-seed');
		await expect(page.getByRole('heading', { name: 'Project Overview' })).toBeVisible();
		await expect(page.getByTestId('branch-switcher')).toHaveCount(0);
	});

	test('creates a branch from the header and lands on it', async ({ page, request }) => {
		const created = await request.post('/api/registry/projects', {
			data: { id: ROOT, name: 'Branch UI' }
		});
		expect(created.status(), await created.text()).toBe(201);

		await gotoProject(page, ROOT);
		await expect(page.getByTestId('branch-switcher')).toContainText('main');

		await page.getByTestId('branch-switcher').click();
		await page.getByTestId('new-branch').click();

		const dialog = page.getByTestId('new-branch-dialog');
		await expect(dialog).toBeVisible();
		await dialog.getByTestId('new-branch-name').fill(BRANCH);
		// The live preview shows the derived project id before anything commits.
		await expect(dialog.getByTestId('new-branch-preview')).toContainText(`${ROOT}--${BRANCH}`);
		await dialog.getByTestId('new-branch-create').click();

		await expect(page).toHaveURL(new RegExp(`/dashboard/${ROOT}--${BRANCH}$`));
		// The breadcrumb keeps root and branch as separate segments: the project
		// crumb names the ROOT, the branch crumb the branch - never `root--branch`.
		await expect(page.getByTestId('project-badge')).toHaveText(ROOT);
		await expect(page.getByTestId('branch-switcher')).toContainText(BRANCH);
	});

	test('rejects an invalid branch name in the dialog', async ({ page }) => {
		await gotoProject(page, ROOT);
		await page.getByTestId('branch-switcher').click();
		await page.getByTestId('new-branch').click();

		const dialog = page.getByTestId('new-branch-dialog');
		await dialog.getByTestId('new-branch-name').fill('UPPER');
		await dialog.getByTestId('new-branch-create').click();

		await expect(dialog.getByTestId('new-branch-error')).toHaveText(
			'Use lowercase letters, numbers, and hyphens only.'
		);
		// Still on the root - nothing was created or navigated.
		await expect(page.getByTestId('project-badge')).toHaveText(ROOT);
	});

	test('switching branches keeps the operator on the same tool page', async ({ page }) => {
		await page.goto(`/dashboard/${ROOT}--${BRANCH}/auth`);
		await expect(page.getByTestId('auth-page')).toHaveAttribute('data-hydrated', 'true');

		await page.getByTestId('branch-switcher').click();
		await page.getByTestId('branch-item-main').click();

		// Same subpage, other branch: only the project segment changes.
		await expect(page).toHaveURL(new RegExp(`/dashboard/${ROOT}/auth$`));
		await expect(page.getByTestId('branch-switcher')).toContainText('main');
	});

	test('the projects overview groups branches under their root', async ({ page }) => {
		await page.goto('/dashboard');
		const list = page.getByTestId('project-list');
		await expect(list.getByText(ROOT, { exact: true })).toBeVisible();

		// The branch renders as an indented child row, never a sibling project.
		const branchLinks = list.locator('a', { hasText: `${ROOT}--${BRANCH}` });
		await expect(branchLinks).toHaveCount(1);
		const branchRow = list.getByTestId('branch-row').filter({ hasText: `${ROOT}--${BRANCH}` });
		await expect(branchRow).toBeVisible();

		await branchRow.click();
		await expect(page).toHaveURL(new RegExp(`/dashboard/${ROOT}--${BRANCH}$`));
	});
});
