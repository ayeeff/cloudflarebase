/**
 * A tab that outlives a deploy points at chunks that no longer exist.
 *
 * Workers static assets are versioned WITH the Worker: every deploy replaces
 * the asset manifest, so `_app/immutable/nodes/6.<hash>.js` becomes a 404 the
 * moment a build changes that node - there is no retention window the way there
 * is on hosts that keep previous deploys served. A tab left open across a deploy
 * therefore holds a module graph the origin can no longer serve, and the first
 * `import()` it makes after that rejects: a route node on navigation, the Scalar
 * bundle on the API page, the shiki highlighter behind the code samples.
 *
 * Browsers word that rejection differently and none of them expose a code, so
 * the message is the only thing to match on. Matching is deliberately NOT the
 * recovery - it only marks a request for a second opinion. `updated.check()`
 * re-reads `_app/version.json`, and only a genuinely newer version justifies
 * reloading: the same rejection under an UNCHANGED version means a broken
 * deploy or a dropped request, and reloading on that would loop instead of heal.
 */

const STALE_MODULE_MESSAGES = [
	/failed to fetch dynamically imported module/i, // Chrome, Edge
	/error loading dynamically imported module/i, // Firefox
	/importing a module script failed/i, // Safari
	/unable to preload css/i, // Vite's preload helper
	/failed to load module script/i, // Chrome, when the miss falls through to HTML
	/disallowed mime type/i // Firefox, same case
];

/** What the error page says when a stale tab surfaces one of these. */
export const STALE_BUILD_MESSAGE =
	'A new version was deployed while this tab was open. Reload to continue - your project is unaffected.';

/** Did this error come from a module the browser could no longer fetch? */
export function isStaleModuleError(error: unknown): boolean {
	const message =
		typeof error === 'string'
			? error
			: typeof (error as { message?: unknown } | null)?.message === 'string'
				? (error as { message: string }).message
				: '';

	return message !== '' && STALE_MODULE_MESSAGES.some((pattern) => pattern.test(message));
}
