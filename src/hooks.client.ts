import { dev } from '$app/environment';
import { env } from '$env/dynamic/public';
import { updated } from '$app/state';
import * as Sentry from '@sentry/sveltekit';
import type { HandleClientError } from '@sveltejs/kit';
import { isStaleModuleError, STALE_BUILD_MESSAGE } from '$lib/stale-build';

/**
 * Error reporting is opt-in and off by default.
 *
 * The DSN used to be hardcoded here, which meant any fork deployed anywhere
 * other than localhost reported its errors into this project's Sentry account.
 * It now comes from PUBLIC_SENTRY_DSN, so a self-hosted install reports
 * nowhere until its operator points it at their own project.
 */
const dsn = env.PUBLIC_SENTRY_DSN ?? '';

const local =
	typeof window !== 'undefined' &&
	(window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

Sentry.init({
	dsn,
	enabled: !!dsn && !dev && !local,
	environment: env.PUBLIC_SENTRY_ENV ?? 'production',
	tracesSampleRate: 0.1
});

// The package's root types resolve to the SERVER overload under this tsconfig
// even though the browser export condition ships the client one, so the cast
// says what actually runs here rather than what the types happened to pick.
const report = Sentry.handleErrorWithSentry() as HandleClientError;

/**
 * Confirm with the origin that a newer build is live, which is what flips
 * `updated.current` and so turns the tab's next navigation into a full page
 * load (the guard in the root layout). Returns false in dev, where SvelteKit
 * stubs the check out - a chunk that fails there is a real error.
 */
const newBuildIsLive = async (): Promise<boolean> => updated.current || (await updated.check());

if (typeof window !== 'undefined') {
	// Vite dispatches this for every failed chunk or CSS preload, including the
	// dynamic imports SvelteKit does not own - the Scalar reference, the shiki
	// highlighter. The listener only asks whether a deploy explains it; the
	// rejection still propagates to whoever called `import()`, because nothing
	// here calls preventDefault.
	window.addEventListener('vite:preloadError', () => void newBuildIsLive());
}

export const handleError: HandleClientError = async (input) => {
	// A stale tab is not an application error. SvelteKit already recovers on a
	// real navigation (it re-checks the version and hands off to the browser),
	// so what reaches here is mostly the hover PRELOAD of a link whose route
	// node has been rebuilt - invisible to the operator, and pure noise in
	// Sentry. Silence it only once a newer version is proven to exist: the same
	// failure on the CURRENT version means the deploy itself is broken, which is
	// worth waking someone for.
	if (isStaleModuleError(input.error) && (await newBuildIsLive())) {
		return { message: STALE_BUILD_MESSAGE };
	}

	return report(input);
};
