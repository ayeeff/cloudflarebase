import { expect, test as setup } from '@playwright/test';
import {
	CONSOLE_OWNER,
	CONSOLE_SETUP_TOKEN,
	CONSOLE_STORAGE_STATE,
	consoleAuthPath
} from './helpers';

/**
 * Claims the console owner and parks the session for every other project.
 *
 * Runs before seeding because the seed itself reads operator-only endpoints.
 * Idempotent for locally reused stacks: once an owner exists the agent refuses
 * further sign-ups on the console instance, so a 403 there is the expected
 * second-run outcome and the sign-in below is what actually matters.
 *
 * The unlock is the first-run claim gate (src/lib/server/console-setup.ts):
 * arriving first is not a credential, so the claim needs proof of deployment
 * control. The e2e stack configures the token rather than switching the gate
 * off, which keeps the real self-hosted path covered.
 */
setup('claim the console owner', async ({ request }) => {
	// Before the unlock, the claim is refused - the whole point of the gate.
	// On a fresh stack this is the guard's `setupLocked`; on a reused one the
	// agent's "already has an owner". Both are 403, and neither creates a user.
	const unproven = await request.post(consoleAuthPath('sign-up/email'), { data: CONSOLE_OWNER });
	expect(unproven.status(), 'an unproven claim must never be accepted').toBe(403);

	const unlock = await request.post('/api/console/setup', {
		data: { token: CONSOLE_SETUP_TOKEN }
	});
	expect(unlock.ok(), await unlock.text()).toBeTruthy();

	const signUp = await request.post(consoleAuthPath('sign-up/email'), { data: CONSOLE_OWNER });
	if (!signUp.ok()) {
		expect(
			signUp.status(),
			'sign-up should either succeed or be refused because an owner exists'
		).toBe(403);
	}

	const signIn = await request.post(consoleAuthPath('sign-in/email'), {
		data: { email: CONSOLE_OWNER.email, password: CONSOLE_OWNER.password }
	});
	expect(signIn.ok(), await signIn.text()).toBeTruthy();

	await request.storageState({ path: CONSOLE_STORAGE_STATE });
});
