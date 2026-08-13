import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { CONSOLE_AUTH_BASE } from '$lib/console';

/**
 * The one sign-out path every console surface shares - the avatar menu and the
 * mobile drawer's button both call this, so the request and the /login landing
 * can never drift between them.
 */
export async function signOutConsole(): Promise<void> {
	await fetch(`${CONSOLE_AUTH_BASE}/sign-out`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: '{}'
	});
	// ONE navigation: invalidating while still on the page re-runs its loads
	// without a session, and on a demo deployment /dashboard would mint a
	// throwaway project before the /login goto lands.
	await goto(resolve('/login'), { invalidateAll: true });
}
