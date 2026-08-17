// The documented slot for values that live OUTSIDE wrangler config. Every
// var, secret, and binding declared in some wrangler.jsonc env is already in
// the generated cross-env union (optional BUCKET, optional AUTH_AGENT
// included), so an augmentation for those would only fight the generated
// literals. Add values here, never by hand-editing worker-configuration.d.ts.
// Never name a sibling `src/env.ts`: it would collide and silently kill the
// ambient augmentation.
//
// Merge into the GLOBAL `Env`, the auth agent's precedent - the generated file
// declares `interface Env extends __BaseEnv_Env` at top level and a separate
// `Cloudflare.Env` that the agent code never names, so augmenting the
// namespace instead compiles but reaches nothing.
interface Env {
	/**
	 * Optional override for the signed-URL signing secret. Generated and kept
	 * by `StorageAgent` when unset (a manifest `secrets.generated` value), so
	 * an install needs nothing configured; supplying it takes ownership of the
	 * value and pins it to secret version 0. Declared in no wrangler config on
	 * purpose - it is `wrangler secret put` material, and a same-named `vars`
	 * entry would override the secret on the next deploy.
	 */
	STORAGE_SIGNING_SECRET?: string;
}
