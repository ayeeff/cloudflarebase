import {
	CONSOLE_SETUP_COOKIE,
	CONSOLE_SETUP_TOKEN_MIN_LENGTH,
	consoleSetupState,
	hasSetupGrant,
	mintSetupGrant,
	verifySetupToken
} from '$lib/server/console-setup';
import { consoleAuthConfig, forgetConsoleOwnerState } from '$lib/server/console';
import { resetConsoleOperators } from '$lib/server/registry';
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

const CONFIRM = 'erase-console-operators';

/**
 * Reclaims a console whose owner is not you - the recovery path for an install
 * that was claimed by a stranger before the gate existed, and for one whose
 * owner account is simply lost.
 *
 * Destructive on purpose: it erases the console AuthAgent, so EVERY operator
 * account, session and organization on the deployment goes with it, and the
 * console returns to unclaimed so the same unlock can claim it. Project data
 * is untouched - each project is its own instance - but registry rows are
 * released to null ownership, because the orgs that owned them no longer
 * exist and the guard would otherwise refuse those projects to everyone.
 *
 * Needs the setup TOKEN, never merely an open deploy window: redeploying is
 * something a deployment does routinely, and it must not be a way to wipe the
 * operators of a console that already has them.
 */
export const DELETE: RequestHandler = async ({ cookies, platform, request, url }) => {
	// Same-origin when the caller is a browser. SameSite=Lax already keeps the
	// grant cookie off a cross-site fetch, so this is belt to that braces - and
	// it stays absent-friendly, because a self-hoster recovering with curl
	// sends no Origin at all.
	const origin = request.headers.get('origin');
	if (origin && origin !== url.origin) {
		return Response.json({ error: 'cross-origin reset refused' }, { status: 403 });
	}

	if (!(await hasSetupGrant(platform, cookies.get(CONSOLE_SETUP_COOKIE)))) {
		return Response.json(
			{ error: 'unlock with the setup token before resetting the console' },
			{ status: 403 }
		);
	}

	// Never on a console that takes public sign-ups. Open mode is the managed
	// shape - many accounts, many organizations, none of whom asked - where
	// "erase every operator and release every project" is not a recovery, it is
	// an outage. The consoles this exists for (claimed, single-owner, possibly
	// squatted) are exactly the ones that do not report open.
	const config = await consoleAuthConfig(platform, url.origin);
	if (config.consoleSignups === 'open') {
		return Response.json(
			{ error: 'a console with open sign-ups cannot be reset - remove operators individually' },
			{ status: 403 }
		);
	}

	// Query or body: a DELETE body is legal but not universally forwarded, and
	// this is the one confirmation standing in front of an irreversible wipe.
	const body = (await request.json().catch(() => null)) as { confirm?: unknown } | null;
	const confirm =
		typeof body?.confirm === 'string' ? body.confirm : url.searchParams.get('confirm');
	if (confirm !== CONFIRM) {
		return Response.json(
			{ error: `this erases every operator account - confirm with "${CONFIRM}"` },
			{ status: 400 }
		);
	}

	const { erased, projectsReleased } = await resetConsoleOperators(platform);
	// The claim gate memoises a claimed console for 60s; this is the one thing
	// that unclaims one, so drop the memo instead of waiting it out.
	forgetConsoleOwnerState(platform);
	if (!erased) {
		return Response.json(
			{ error: 'could not reach the auth agent - nothing was erased' },
			{ status: 502 }
		);
	}

	return Response.json({ ok: true, projectsReleased });
};
