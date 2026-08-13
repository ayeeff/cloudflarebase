import { expect, test } from '@playwright/test';

/**
 * The project settings page (the account-shell era): rename writes the
 * registry row through PATCH /api/registry/projects/:id (display name only,
 * the id is immutable), and delete is a typed-id confirmation that erases
 * the project and lands back on the projects overview.
 *
 * Fresh ids per run: registry rows are permanent on locally reused stacks.
 */
const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 12);
const projectId = `e2e-set-${runId}`;

test.describe('project settings', () => {
	// Rename then delete drive ONE project through its lifecycle in order.
	test.describe.configure({ mode: 'serial' });

	test.beforeAll(async ({ request }) => {
		const created = await request.post('/api/registry/projects', {
			data: { id: projectId, name: 'Settings Spec' }
		});
		expect(created.status(), await created.text()).toBe(201);
	});

	test.afterAll(async ({ request }) => {
		// Idempotent cleanup for the failure path; the happy path already
		// deleted the row through the UI.
		await request.delete(`/api/registry/projects/${projectId}`);
	});

	test('renames the display name, never the id', async ({ page }) => {
		await page.goto(`/dashboard/${projectId}/settings`);

		const name = page.getByLabel('Name');
		await expect(name).toHaveValue('Settings Spec');
		await name.fill('Renamed by the spec');
		await page.getByTestId('rename-project').click();
		await expect(page.getByText('Saved.')).toBeVisible();

		// The overview reflects the new name; the id is untouched.
		await page.goto('/dashboard');
		const list = page.getByTestId('project-list');
		await expect(list.getByText('Renamed by the spec')).toBeVisible();
		await expect(list.getByText(projectId, { exact: true })).toBeVisible();
	});

	test('deleting requires typing the id back', async ({ page }) => {
		await page.goto(`/dashboard/${projectId}/settings`);
		await page.getByTestId('delete-project').click();

		// The destructive action stays disabled until the id matches exactly.
		const submit = page.getByTestId('delete-project-submit');
		await expect(submit).toBeDisabled();
		await page.getByTestId('delete-project-confirm').fill(projectId);
		await submit.click();

		await page.waitForURL(/\/dashboard$/);
		await expect(page.getByTestId('project-list').getByText(projectId)).toHaveCount(0);
	});
});
