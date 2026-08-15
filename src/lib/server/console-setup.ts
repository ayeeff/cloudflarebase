import { CONSOLE_PROJECT_ID } from '$lib/console';
import { consoleOwnerExists } from '$lib/server/console';
import { redirect } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';

/**
 * Proof of deployment control for the first-run console claim.
 *
 * The claim used to be gated on a fact about the WORLD - `count(user) === 0` -
 * rather than a fact about the CLAIMER. Arriving first was the whole
 * credential, so any stranger who guessed a self-hosted URL (workers.dev names
 * are enumerable, and this repo's default Worker name is `cloudflarebase`)
 * could take ownership of someone else's install, and `ensureConsoleAdmin`
 * then promoted them to admin over every operator surface on it.
 *
 * The person who deployed the Worker is the owner, so the claim asks for
 * something only they can produce. Two proofs, in order of how a real install
 * actually goes:
 *
 * 1. A FRESH DEPLOY. `CF_VERSION_METADATA.timestamp` is when the running
 *    version was created, which no visitor can influence - only someone who
 *    can push a version to this account can move it. The claim is open for 30
 *    minutes after it, which is exactly the honest deployer's path (deploy,
 *    open the URL, claim) and costs them no extra step. Miss it and
 *    `wrangler deploy` reopens the window; a stranger who finds the install
 *    later gets a locked page with nothing to submit.
 *
 * 2. A SETUP TOKEN. `wrangler secret put CONSOLE_SETUP_TOKEN` - writable only
 *    with account credentials, applied without a redeploy. It overrides the
 *    window entirely, which makes it both the answer for anyone who cannot
 *    redeploy on demand and the break-glass recovery for an install a squatter
 *    already claimed.
 *
 * Neither is required configuration: a fresh clone still deploys with nothing
 * set and is claimable by whoever just deployed it.
 */

/**
 * Carries a token-proved unlock across requests - including the OAuth round
 * trip, where the browser comes back from google.com with no way to resubmit
 * the token. SameSite=Lax so it survives that top-level navigation.
 */
export const CONSOLE_SETUP_COOKIE = 'cfbase-console-setup';

/** How long a fresh deploy - or a token unlock - keeps the claim open. */
export const CONSOLE_SETUP_WINDOW_MS = 30 * 60 * 1000;

/**
 * Below this a setup token is a guess, not a credential. Refusing short ones
 * outright beats accepting `hunter2` and calling the install protected - the
 * unlock route is reachable by anyone who can reach the login page.
 */
export const CONSOLE_SETUP_TOKEN_MIN_LENGTH = 24;

export type ConsoleSetupState = {
	/** Whether a claim may proceed right now. */
	unlocked: boolean;
	/** What unlocked it - or why nothing did. Drives the login page's copy. */
	reason: 'window' | 'token' | 'dev' | 'locked';
	/** Whether CONSOLE_SETUP_TOKEN is set AND long enough to count. */
	tokenConfigured: boolean;
	/** Set but too short: the operator needs telling, not silently ignoring. */
	tokenTooShort: boolean;
	/** When the fresh-deploy window closes, if it is open. */
	windowEndsAt: number | null;
};

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sign(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

/**
 * Compares digests rather than the strings themselves, so the loop always runs
 * over 32 bytes and neither length nor first-difference position is timeable.
 */
async function equals(a: string, b: string): Promise<boolean> {
	const [left, right] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(a)),
		crypto.subtle.digest('SHA-256', encoder.encode(b))
	]);
	const x = new Uint8Array(left);
	const y = new Uint8Array(right);
	let diff = 0;
	for (let i = 0; i < x.length; i += 1) diff |= x[i]! ^ y[i]!;
	return diff === 0;
}

/** The configured token, or null when it is absent or too short to count. */
function setupToken(platform: App.Platform | undefined): string | null {
	const token = platform?.env?.CONSOLE_SETUP_TOKEN;
	if (!token || token.length < CONSOLE_SETUP_TOKEN_MIN_LENGTH) return null;
	return token;
}

/**
 * When the running Worker version was created. Only someone who can deploy to
 * this Cloudflare account can move it, which is the entire point - a visitor
 * cannot open the window by arriving, only by deploying.
 */
function deployedAt(platform: App.Platform | undefined): number | null {
	const timestamp = platform?.env?.CF_VERSION_METADATA?.timestamp;
	if (!timestamp) return null;
	const parsed = typeof timestamp === 'number' ? timestamp : Date.parse(String(timestamp));
	return Number.isFinite(parsed) ? parsed : null;
}

/** A `<expiry>.<hmac>` cookie value, unforgeable without the setup token. */
async function grantValid(token: string, value: string | undefined): Promise<boolean> {
	const [expiry, signature] = (value ?? '').split('.');
	const expiresAt = Number(expiry);
	if (!signature || !Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
	return equals(signature, await sign(token, `console-setup.${expiry}`));
}

/** Mints the cookie value a successful token unlock carries. */
export async function mintSetupGrant(token: string): Promise<{ value: string; maxAge: number }> {
	const expiresAt = Date.now() + CONSOLE_SETUP_WINDOW_MS;
	return {
		value: `${expiresAt}.${await sign(token, `console-setup.${expiresAt}`)}`,
		maxAge: Math.floor(CONSOLE_SETUP_WINDOW_MS / 1000)
	};
}

/** Whether a submitted token matches the configured one. */
export async function verifySetupToken(
	platform: App.Platform | undefined,
	candidate: string
): Promise<boolean> {
	const token = setupToken(platform);
	if (!token || !candidate) return false;
	return equals(token, candidate);
}

/**
 * Whether the first-run claim may proceed, and why. Cheap by design: the
 * window and the token both read env, and the grant costs one HMAC - so the
 * steady state (a claimed console, nothing to unlock) pays nothing.
 */
export async function consoleSetupState(
	platform: App.Platform | undefined,
	grantCookie?: string
): Promise<ConsoleSetupState> {
	const rawToken = platform?.env?.CONSOLE_SETUP_TOKEN;
	const token = setupToken(platform);
	const base = {
		tokenConfigured: !!token,
		tokenTooShort: !!rawToken && !token,
		windowEndsAt: null as number | null
	};

	// Local dev and the e2e stack only. A deployed console must never set this:
	// it is the gate itself, switched off.
	if (platform?.env?.CONSOLE_SETUP_UNLOCKED === 'true') {
		return { ...base, unlocked: true, reason: 'dev' };
	}

	const deployed = deployedAt(platform);
	const endsAt = deployed === null ? null : deployed + CONSOLE_SETUP_WINDOW_MS;
	if (endsAt !== null && Date.now() < endsAt) {
		return { ...base, unlocked: true, reason: 'window', windowEndsAt: endsAt };
	}

	if (token && (await grantValid(token, grantCookie))) {
		return { ...base, unlocked: true, reason: 'token' };
	}

	return { ...base, unlocked: false, reason: 'locked' };
}

/**
 * Whether a path is one of the routes that can CREATE the console's first
 * account. Both doors are covered: the REST proxy the browser uses, and the
 * `/agents/*` passthrough, which reaches the same agent without one. Both
 * classify as public (the auth manifest publishes `/api/auth/*`), so the guard
 * is the only place that sees them.
 *
 * Password sign-in is deliberately absent - with no accounts there is nothing
 * to sign into - and so is every other Better Auth route: the callback is here
 * because social sign-in creates the user implicitly on the way back.
 */
export function isConsoleClaimSurface(pathname: string): boolean {
	const segments = pathname.split('/').filter(Boolean);

	let rest: string[] | null = null;
	// /api/projects/console/auth/<...>
	if (
		segments[0] === 'api' &&
		segments[1] === 'projects' &&
		segments[2] === CONSOLE_PROJECT_ID &&
		segments[3] === 'auth'
	) {
		rest = segments.slice(4);
	}
	// /agents/<worker>/console/api/auth/<...>
	else if (
		segments[0] === 'agents' &&
		segments[2] === CONSOLE_PROJECT_ID &&
		segments[3] === 'api' &&
		segments[4] === 'auth'
	) {
		rest = segments.slice(5);
	}
	if (!rest) return false;

	const subPath = rest.join('/');
	return subPath === 'sign-up/email' || subPath === 'sign-in/social' || rest[0] === 'callback';
}

/**
 * Refuses an unproven first-run claim, or null to let the request through.
 *
 * Only ever refuses while the console has NO owner: once it is claimed these
 * same routes are ordinary sign-in and invited-teammate sign-up, and the
 * agent's own rules apply. That ordering is also what keeps the cost off the
 * hot path - a locked, claimed console pays one `/overview` read on the two or
 * three auth routes that reach here, and nothing anywhere else.
 */
export async function guardConsoleClaim(event: RequestEvent): Promise<Response | null> {
	if (!isConsoleClaimSurface(event.url.pathname)) return null;

	const state = await consoleSetupState(
		event.platform,
		event.cookies.get(CONSOLE_SETUP_COOKIE) ?? undefined
	);
	if (state.unlocked) return null;

	// Claimed already: nothing here is a claim, so nothing to gate. Fails
	// CLOSED - an agent that cannot answer reads as unclaimed, and refusing a
	// sign-in during an outage beats handing out an ownership window.
	if (await consoleOwnerExists(event.platform, event.url.origin)) return null;

	// An OAuth callback is a browser navigation; JSON would strand it on a
	// blank page. Bounce to the login page, which explains the lock.
	if (event.url.pathname.includes('/callback/')) {
		redirect(303, '/login?error=setup_locked');
	}

	return Response.json(
		{
			error:
				'console setup is locked - redeploy this Worker to reopen it, or set CONSOLE_SETUP_TOKEN',
			code: 'setupLocked'
		},
		{ status: 403 }
	);
}
