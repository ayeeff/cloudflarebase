import {
	CONSOLE_SETUP_COOKIE,
	CONSOLE_SETUP_TOKEN_MIN_LENGTH,
	consoleSetupState,
	mintSetupGrant,
	verifySetupToken
} from '$lib/server/console-setup';
import type { RequestHandler } from './$types';

/**
 * Unlocks the first-run console claim with the setup token.
 *
 * Public by exception, like the two GitHub routes: there is no session to
 * authenticate against on an unclaimed console, and the token IS the
 * credential - writable only with Cloudflare account credentials
 * (`wrangler secret put CONSOLE_SETUP_TOKEN`). A success mints a 30-minute
 * signed cookie rather than echoing anything back, so the proof survives the
 * OAuth round trip without the token ever being resubmitted.
 *
 * Unlocking alone grants nothing: the guard still refuses the claim once the
 * console has an owner.
 */
export const POST: RequestHandler = async ({ cookies, platform, request }) => {
	const state = await consoleSetupState(platform);

	if (!state.tokenConfigured) {
		return Response.json(
			{
				error: state.tokenTooShort
					? `CONSOLE_SETUP_TOKEN is too short - use at least ${CONSOLE_SETUP_TOKEN_MIN_LENGTH} characters`
					: 'no setup token is configured on this deployment'
			},
			{ status: 403 }
		);
	}

	const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
	const candidate = typeof body?.token === 'string' ? body.token : '';

	if (!(await verifySetupToken(platform, candidate))) {
		return Response.json({ error: 'that setup token is not correct' }, { status: 403 });
	}

	const grant = await mintSetupGrant(candidate);
	cookies.set(CONSOLE_SETUP_COOKIE, grant.value, {
		path: '/',
		httpOnly: true,
		// Lax, not Strict: the OAuth callback returns as a top-level navigation
		// from the provider, and Strict would drop the cookie exactly there.
		sameSite: 'lax',
		secure: true,
		maxAge: grant.maxAge
	});

	return Response.json({ ok: true });
};
