import adapter from '@sveltejs/adapter-cloudflare';

const e2e = process.env.E2E_BUILD === 'true';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		// adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
		// If your environment is not supported, or you settled on a specific environment, switch out the adapter.
		// See https://svelte.dev/docs/kit/adapters for more information about adapters.
		adapter: adapter(e2e ? { config: 'wrangler.e2e.jsonc' } : undefined),
		csrf: {
			// Re-implemented in `csrfHandle` (src/hooks.server.ts), NOT disabled.
			//
			// SvelteKit's check runs before every hook and refuses form content
			// types (text/plain, multipart/form-data, x-www-form-urlencoded) on a
			// write whose Origin does not match - treating a MISSING Origin as
			// cross-site. That is right for cookies and wrong for bearers: a
			// service-key request has no Origin by construction (the guard refuses
			// the key if one is present), and `fetch` defaults a string body -
			// `JSON.stringify(...)` included - to text/plain. So the most natural
			// call a server can write was answered 403 before the key was read.
			//
			// The replacement applies SvelteKit's exact rule to ambient
			// credentials and skips it only when an `Authorization` header is
			// present, which a browser cannot attach cross-origin without a
			// preflight we never answer. Turning this off without that handle
			// would make the whole console API CSRF-able, sign-in included.
			checkOrigin: false
		},
		version: {
			// Deploys replace this Worker's asset manifest wholesale, so an open
			// tab's hashed chunks 404 the moment a build changes them. Polling
			// `_app/version.json` is what lets the tab NOTICE a deploy on its own,
			// which flips `updated` and makes the root layout's guard hand the next
			// navigation to the browser - before an import can fail rather than
			// after. Five minutes: the request is a static asset the size of a
			// tweet, and a console tab already polls its agents every five seconds.
			pollInterval: 300_000
		}
	}
};

export default config;
