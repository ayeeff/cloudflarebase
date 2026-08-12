// Optional secrets set via `wrangler secret put` - not present in wrangler.jsonc
// vars, so they are augmented here instead of hand-editing the generated
// worker-configuration.d.ts.
interface Env {
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	GITHUB_CLIENT_ID?: string;
	GITHUB_CLIENT_SECRET?: string;
	DISABLE_RATE_LIMIT?: 'true';
	/** Enable Analytics Engine SQL API querying (writes need no credentials). */
	CF_ACCOUNT_ID?: string;
	CF_ANALYTICS_API_TOKEN?: string;
}
// CONSOLE_SIGNUPS is not augmented here: env.local declares it, so it lives
// in the generated worker-configuration.d.ts (docs/managed-service-design.md
// - unset/claimed = invitation-only, open = public sign-ups, and open only
// takes effect while the EMAIL binding + EMAIL_FROM are configured).
