import { expect, test, type Page } from '@playwright/test';
import {
	authPage,
	SEED_PASSWORD,
	SEED_PROJECT,
	SEED_TOTAL_USERS,
	SEED_USERS,
	uniqueEmail
} from './helpers';

/** Project used by the interactive flows - separate from the read-only seed. */
const UI_PROJECT = 'e2e-ui';

function statValue(page: Page, id: string) {
	return page.getByTestId(`stat-${id}`).getByTestId('stat-value');
}

async function gotoAuthPage(page: Page, projectId: string) {
	await page.goto(authPage(projectId));
	await expect(page.getByTestId('auth-page')).toHaveAttribute('data-hydrated', 'true');
}

test.describe('authentication page (frontend)', () => {
	test('shows the seeded project data', async ({ page }) => {
		await gotoAuthPage(page, SEED_PROJECT);

		await expect(statValue(page, 'users')).toHaveText(String(SEED_TOTAL_USERS));
		await expect(statValue(page, 'sessions')).not.toHaveText('0');
		await expect(statValue(page, 'dau')).toHaveText(/^(—|\d+)$/);
		await expect(statValue(page, 'mau')).toHaveText(/^(—|\d+)$/);

		const usersCard = page.getByTestId('users-card');
		for (const user of SEED_USERS) {
			await expect(usersCard.getByText(user.email)).toBeVisible();
		}

		// Live feed shows auth events. Behavioral panels may be empty in local CI,
		// where Analytics Engine SQL credentials are intentionally not configured.
		await expect(
			page
				.getByTestId('activity-card')
				.getByText(/signed up|session started/)
				.first()
		).toBeVisible();
	});

	test('connects to the agent for live updates', async ({ page }) => {
		await gotoAuthPage(page, SEED_PROJECT);

		// On the local prod-mirroring stack the WebSocket passthrough is verified
		// to work, so demand true realtime. Remote stacks (e.g. BrowserStack
		// against a tunnel) may legitimately land on the polling fallback.
		const expected = process.env.BASE_URL ? /realtime|polling/ : 'realtime';
		await expect(page.getByTestId('connection-status')).toHaveText(expected);
	});

	test('sign-up through the playground updates stats, tables and feed', async ({ page }) => {
		const email = uniqueEmail('ui-signup');

		await gotoAuthPage(page, UI_PROJECT);
		const usersBefore = Number(await statValue(page, 'users').textContent());

		await page.getByTestId('nav-auth-playground').click();
		await page.locator('#su-name').fill('Playground User');
		await page.locator('#su-email').fill(email);
		await page.locator('#su-password').fill('playground-password-1');
		await page.getByRole('button', { name: 'Create account' }).click();

		// Session panel reflects the new identity…
		const sessionPanel = page.getByTestId('session-panel');
		await expect(sessionPanel.getByText('Playground User')).toBeVisible();
		await expect(sessionPanel.getByText(email)).toBeVisible();

		// …and the project data follows. The live-activity feed lives on the
		// Users overview, so assert it there before moving on to Sessions.
		await expect(statValue(page, 'users')).toHaveText(String(usersBefore + 1));
		await page.getByTestId('nav-auth').click();
		await expect(page.getByTestId('users-card').getByText(email)).toBeVisible();
		await expect(
			page.getByTestId('activity-card').getByText('registered user created')
		).toBeVisible();
		await page.getByTestId('nav-auth-sessions').click();
		await expect(page.getByTestId('sessions-card').getByText(email)).toBeVisible();
	});

	test('validates sign-up and sign-in fields before sending auth requests', async ({ page }) => {
		await gotoAuthPage(page, 'e2e-ui-validation');
		await page.getByTestId('nav-auth-playground').click();

		await page.locator('#su-name').fill('A');
		await page.locator('#su-email').fill('invalid');
		await page.locator('#su-password').fill('short');
		await page.getByRole('button', { name: 'Create account' }).click();

		await expect(page.getByText('Enter at least 2 characters.')).toBeVisible();
		await expect(page.getByText('Enter a valid email address.')).toBeVisible();
		await expect(page.getByText('Password must be at least 8 characters.')).toBeVisible();
		await expect(page.locator('#su-email')).toHaveAttribute('aria-invalid', 'true');

		await page.getByRole('tab', { name: 'Sign in' }).click();
		await page.locator('#si-email').fill('invalid');
		await page.locator('#si-password').fill('');
		await page.getByRole('button', { name: 'Sign in', exact: true }).click();

		await expect(page.getByText('Enter a valid email address.')).toBeVisible();
		await expect(page.getByText('Enter your password.')).toBeVisible();
		await expect(page.locator('#si-password')).toHaveAttribute('aria-invalid', 'true');
	});

	test('guest sign-in creates an anonymous user', async ({ page }) => {
		await gotoAuthPage(page, UI_PROJECT);

		await page.getByTestId('nav-auth-playground').click();
		await page.getByTestId('guest-button').click();

		await expect(page.getByTestId('auth-success')).toContainText('Guest session started');
		const sessionPanel = page.getByTestId('session-panel');
		await expect(sessionPanel.getByText('Anonymous')).toBeVisible();

		await page.getByTestId('nav-auth').click();
		await expect(page.getByTestId('users-card').getByText('anonymous').first()).toBeVisible();
	});

	test('new-identity dice fills the sign-up form with a unique demo user', async ({ page }) => {
		await gotoAuthPage(page, 'e2e-ui-dice');
		await page.getByTestId('nav-auth-playground').click();

		await expect(page.locator('#su-name')).toHaveValue('');
		await expect(page.locator('#su-email')).toHaveValue('');

		await page.getByTestId('randomize-identity').click();
		await expect(page.locator('#su-name')).not.toHaveValue('');
		await expect(page.locator('#su-email')).toHaveValue(/@example\.com$/);
		await expect(page.locator('#su-password')).not.toHaveValue('');

		await page.getByRole('button', { name: 'Create account' }).click();
		await expect(page.getByTestId('auth-success')).toContainText('signed in');
	});

	test('roles tab manages roles and permissions and assigns them to users', async ({ page }) => {
		const project = 'e2e-ui-roles';
		const email = uniqueEmail('roles');
		await gotoAuthPage(page, project);

		// A user to assign roles to.
		await page.getByTestId('nav-auth-playground').click();
		await page.getByTestId('randomize-identity').click();
		await page.locator('#su-email').fill(email);
		await page.getByRole('button', { name: 'Create account' }).click();
		await expect(page.getByTestId('session-panel').getByText(email)).toBeVisible();

		// Define a custom role and grant it a permission.
		await page.getByTestId('nav-auth-roles').click();
		await expect(page.getByTestId('role-user')).toBeVisible();
		await expect(page.getByTestId('role-admin')).toBeVisible();
		await page.getByLabel('New role name').fill('editor');
		await page.getByRole('button', { name: 'Add role' }).click();
		const editorCard = page.getByTestId('role-editor');
		await expect(editorCard).toBeVisible();
		await editorCard.getByLabel('New permission for editor').fill('posts:write');
		await editorCard.getByRole('button', { name: 'Grant' }).click();
		await expect(editorCard.getByText('posts:write')).toBeVisible();

		// Assign it from the users table.
		await page.getByTestId('nav-auth').click();
		await page.getByLabel(`Role for ${email}`).click();
		await page.getByRole('option', { name: 'editor' }).click();
		await expect(page.getByLabel(`Role for ${email}`)).toHaveText('editor');
	});

	test('integration tab switches between framework examples', async ({ page }) => {
		const project = 'e2e-ui-integration';
		await gotoAuthPage(page, project);
		await page.getByTestId('nav-auth-integration').click();

		const card = page.getByTestId('connect-card');
		await expect(card).toContainText(`/api/projects/${project}/auth`);

		await page.getByRole('tab', { name: 'Python' }).click();
		await expect(card).toContainText('requests.post');
		await page.getByRole('tab', { name: 'cURL' }).click();
		await expect(card).toContainText('curl -i -X POST');
		await page.getByRole('tab', { name: 'Better Auth client' }).click();
		await expect(card).toContainText('createAuthClient');
	});

	test('activity chart range picker switches windows', async ({ page }) => {
		await gotoAuthPage(page, SEED_PROJECT);

		await expect(page.getByTestId('activity-chart')).toBeVisible();
		const trigger = page.getByTestId('activity-range');
		await expect(trigger).toContainText('Last week');

		await trigger.click();
		await page.getByRole('option', { name: 'Last 90 days' }).click();
		await expect(trigger).toContainText('Last 90 days');
		await expect(page.getByTestId('activity-chart')).toBeVisible();
	});

	test('copilot offers three suggestions once history loads', async ({ page }) => {
		await gotoAuthPage(page, SEED_PROJECT);

		await expect(page.getByTestId('project-copilot')).toBeVisible();
		await expect(page.getByTestId('copilot-suggestions').getByRole('button')).toHaveCount(3);
	});

	test('sign-in and sign-out round trip on the seeded project', async ({ page }) => {
		await gotoAuthPage(page, SEED_PROJECT);

		await page.getByTestId('nav-auth-playground').click();
		await page.getByRole('tab', { name: 'Sign in' }).click();
		await page.locator('#si-email').fill(SEED_USERS[0].email);
		await page.locator('#si-password').fill(SEED_PASSWORD);
		await page.getByRole('button', { name: 'Sign in', exact: true }).click();

		const sessionPanel = page.getByTestId('session-panel');
		await expect(sessionPanel.getByText(SEED_USERS[0].name)).toBeVisible();

		await sessionPanel.getByRole('button', { name: 'Sign out' }).click();
		await expect(sessionPanel.getByText('No active session on this browser')).toBeVisible();
	});

	test('chat with the agent answers analytics questions', async ({ page }) => {
		test.skip(!process.env.RUN_AI_E2E, 'set RUN_AI_E2E=1 to test the real Workers AI binding');
		await gotoAuthPage(page, SEED_PROJECT);

		await expect(page.getByTestId('project-copilot')).toBeVisible();
		const messages = page.getByTestId('copilot-messages');
		// Suggestions rotate randomly, so click whichever one is offered first.
		await page.getByTestId('copilot-suggestions').getByRole('button').first().click();
		await expect(messages.getByText('Generated by Workers AI').first()).toBeVisible();

		await page.getByLabel('Ask project agent').fill("What's our DAU?");
		await page.getByRole('button', { name: 'Send to project agent' }).click();
		await expect(messages.getByText(/DAU|daily active/i)).toBeVisible();
	});

	test('connect guide and trusted-origin settings are functional', async ({ page }) => {
		const project = 'e2e-ui-settings';
		await gotoAuthPage(page, project);
		await page.getByTestId('nav-auth-integration').click();
		await expect(page.getByTestId('connect-card')).toContainText(`/api/projects/${project}/auth`);
		await page.getByTestId('nav-auth-settings').click();
		await page.locator('#allowed-origins').fill('https://app.example.com\nhttp://localhost:3000');
		await page.getByRole('button', { name: 'Save changes' }).click();
		await expect(page.getByText('Settings saved.')).toBeVisible();
		await page.reload();
		await page.getByTestId('nav-auth-settings').click();
		await expect(page.locator('#allowed-origins')).toHaveValue(
			'https://app.example.com\nhttp://localhost:3000'
		);
	});

	test('theme and social provider controls persist', async ({ page }) => {
		const project = 'e2e-ui-provider';
		await gotoAuthPage(page, project);
		await page.getByTestId('theme-toggle').click();
		const selectedTheme = await page
			.locator('html')
			.evaluate((element) => (element.classList.contains('dark') ? 'dark' : 'light'));
		await page.reload();
		expect(
			await page
				.locator('html')
				.evaluate((element) => (element.classList.contains('dark') ? 'dark' : 'light'))
		).toBe(selectedTheme);

		await page.getByTestId('nav-auth-settings').click();
		await page.getByTestId('provider-github').getByRole('checkbox').check();
		await page.getByLabel('GitHub client ID').fill('e2e-github-id');
		await page.getByLabel('GitHub client secret').fill('e2e-github-secret');
		await page.getByRole('button', { name: 'Save changes' }).click();
		await expect(page.getByText('Settings saved.')).toBeVisible();
		await page.reload();
		await page.getByTestId('nav-auth-settings').click();
		await expect(page.getByTestId('provider-github').getByRole('checkbox')).toBeChecked();
		await expect(page.getByLabel('GitHub client secret')).toHaveValue('');
	});

	test('deleting a user from the console removes the identity', async ({ page }) => {
		const project = 'e2e-ui-delete';
		const email = uniqueEmail('ui-delete');
		await gotoAuthPage(page, project);
		await page.getByTestId('nav-auth-playground').click();
		await page.locator('#su-name').fill('Disposable User');
		await page.locator('#su-email').fill(email);
		await page.locator('#su-password').fill('disposable-password-1');
		await page.getByRole('button', { name: 'Create account' }).click();
		await expect(statValue(page, 'users')).toHaveText('1');
		await page.getByTestId('nav-auth').click();
		await expect(page.getByTestId('users-card').getByText(email)).toBeVisible();
		page.once('dialog', (dialog) => dialog.accept());
		await page.getByRole('button', { name: `Delete ${email}` }).click();
		await expect(page.getByTestId('users-card').getByText(email)).not.toBeVisible();
	});

	test('switching projects via the breadcrumb lands on an isolated overview', async ({
		page,
		request
	}) => {
		// The breadcrumb dropdown lists REGISTRY projects, so the switch target
		// must be a real registry row - unique per run, since local stacks are
		// reused and registry ids are permanent for the stack's lifetime.
		const target =
			`uisw-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`.slice(
				0,
				24
			);
		const created = await request.post('/api/registry/projects', {
			data: { id: target, name: 'Switch Target' }
		});
		expect(created.status(), await created.text()).toBe(201);

		await gotoAuthPage(page, SEED_PROJECT);
		const switcher = page.getByTestId('project-switcher');
		await expect(switcher).toHaveAttribute('data-hydrated', 'true');
		await switcher.click();
		await page.getByTestId(`project-item-${target}`).click();

		await expect(page).toHaveURL(new RegExp(`/dashboard/${target}$`));
		await expect(page.getByRole('heading', { name: 'Project Overview' })).toBeVisible();
		await expect(page.getByTestId('overview-users-count')).toHaveText('0');

		// Sidebar navigation into the empty project's auth page.
		await page.getByTestId('nav-auth').click();
		await expect(statValue(page, 'users')).toHaveText('0');
		await expect(page.getByTestId('users-card').getByText('No users yet')).toBeVisible();
	});

	test('the auth card’s Integration button opens the integration tab', async ({ page }) => {
		const project = 'e2e-ui-deeplink';
		await page.goto(`/dashboard/${project}`);
		// Each live agent card carries its own Integration link now (the hero
		// card's "View integration guide" moved into them).
		await page.getByTestId('product-auth').getByRole('link', { name: 'Integration' }).click();

		await expect(page.getByTestId('auth-page')).toHaveAttribute('data-hydrated', 'true');
		await expect(page.getByTestId('connect-card')).toContainText(`/api/projects/${project}/auth`);
	});

	// The free-text project switcher (and with it the HTML-injection vector its
	// XSS spec pinned) was retired for the breadcrumb dropdown: project ids now
	// come from the registry, never from typed input.
});
