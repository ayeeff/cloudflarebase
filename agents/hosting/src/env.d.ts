// Optional secrets set via `wrangler secret put` - not present in wrangler.jsonc
// vars, so they are augmented here instead of hand-editing the generated
// worker-configuration.d.ts (the auth agent's precedent).
interface Env {
	/** Account Analytics Read token: with CF_ACCOUNT_ID it unlocks the
	 * analytics tab's SQL reads. Writes need no credentials. */
	CF_ANALYTICS_API_TOKEN?: string;
}
