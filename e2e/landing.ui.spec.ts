import { expect, test } from '@playwright/test';

test.describe('landing page (frontend)', () => {
	test('renders the hero and the live feature grid', async ({ page }) => {
		await page.goto('/');

		await expect(page.getByRole('heading', { level: 1 })).toContainText(
			'The open-source Firebase for Cloudflare'
		);
		await expect(
			page.getByRole('heading', { name: 'Auth shipped first. Database just followed.' })
		).toBeVisible();
		await expect(
			page.getByRole('heading', { name: 'Every Firebase primitive. One agent at a time.' })
		).toBeVisible();

		// The hero visual opens on the db agent and the tabs are real controls.
		const heroTabs = page.getByRole('tablist', { name: 'Agent' });
		await expect(heroTabs.getByRole('tab', { name: 'db-agent' })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await heroTabs.getByRole('tab', { name: 'auth-agent' }).click();
		await expect(page.getByText('AuthAgent · DO SQLite')).toBeVisible();
	});

	test('"Open the live demo" leads to the demo project dashboard', async ({ page }) => {
		await page.goto('/');

		await page.getByRole('link', { name: 'Open the live demo' }).first().click();

		await expect(page).toHaveURL(/\/dashboard\/demo-[a-f0-9]{20}$/);
		await expect(page.getByRole('heading', { name: 'Project Overview' })).toBeVisible();
		const projectId = (await page.getByTestId('project-badge').textContent())!;
		expect(projectId).toMatch(/^demo-[a-f0-9]{20}$/);
		await expect(page.getByTestId('project-copilot')).toBeVisible();

		// The Firebase-style sidebar navigates into Authentication.
		await page.getByTestId('nav-auth').click();
		await expect(page).toHaveURL(new RegExp(`/dashboard/${projectId}/auth$`));
		await expect(page.getByRole('heading', { name: 'Authentication' })).toBeVisible();
	});

	test('the browser resumes its isolated demo project', async ({ page }) => {
		await page.goto('/dashboard');
		const first = page.url();
		await page.goto('/');
		await page.goto('/dashboard');
		expect(page.url()).toBe(first);
	});
});
