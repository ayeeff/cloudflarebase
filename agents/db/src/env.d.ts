// Bindings that exist only in OTHER deployment shapes, so `wrangler types`
// never emits them from this repository's config - augmented here instead of
// hand-editing the generated worker-configuration.d.ts. Declaration inputs
// are not copied to dist, so nothing here ships.
interface Env {
	/**
	 * Single-worker consumer installs host the AuthAgent class beside this
	 * agent; JWKS fetches go through the namespace there. This repo's own
	 * deployment uses the AUTH_AGENT service binding instead.
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	AuthAgent?: DurableObjectNamespace<any>;

	/**
	 * How long the worker caches a project's PUBLISHED Remote Config before
	 * asking the coordinator again. Unset = 30 seconds; `0` disables the cache,
	 * which costs one RPC per config fetch and is what the e2e stack uses so a
	 * publish is visible to the very next request.
	 *
	 * This window IS the publish propagation delay, and it is deliberately a var
	 * rather than a constant: an install serving a lot of app starts wants it
	 * higher, and one demoing a flag flip wants it at zero.
	 */
	REMOTE_CONFIG_CACHE_SECONDS?: string;
}
