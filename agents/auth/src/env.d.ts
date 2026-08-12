// Optional secrets set via `wrangler secret put` - not present in wrangler.jsonc
// vars, so they are augmented here instead of hand-editing the generated
// worker-configuration.d.ts.
interface Env {
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	DISABLE_RATE_LIMIT?: 'true';
	/** Enable Analytics Engine SQL API querying (writes need no credentials). */
	CF_ACCOUNT_ID?: string;
	CF_ANALYTICS_API_TOKEN?: string;
	/**
	 * Console registration policy (docs/managed-service-design.md): unset or
	 * `claimed` = first claim wins then invitation-only; `open` = public
	 * sign-ups with required email verification (needs RESEND_API_KEY).
	 */
	CONSOLE_SIGNUPS?: string;
	/** Resend-shaped HTTP mail provider - the sender open sign-ups require. */
	RESEND_API_KEY?: string;
	/** Override the provider endpoint (any POST /emails-shaped sender fits). */
	RESEND_BASE_URL?: string;
}
