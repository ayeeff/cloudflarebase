/**
 * The binding contract for a Worker hosting `@cloudflarebase/hosting`.
 *
 * `AssertHostingAgentEnv<Env>` is an identity type whose CONSTRAINT does the
 * checking: the consumer's entrypoint template instantiates it with their
 * generated `Env`, so a missing or mistyped binding fails their typecheck
 * with the field named, before anything deploys. Required vs optional here
 * describes what a correct deployment provides, not what the runtime happens
 * to tolerate.
 */

// The namespace type is effectively invariant, so `never` and `unknown` each
// fail one direction; `any` is what accepts every concrete class.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDurableObjectNamespace = DurableObjectNamespace<any>;

export interface HostingAgentBindings {
	/** The orchestrator Durable Object, one instance per project. */
	HostingAgent: AnyDurableObjectNamespace;
	/** Workers for Platforms dispatch namespace. Optional on purpose: WfP is a
	 * paid add-on, and without it the agent answers hosting requests 503
	 * instead of failing the whole install's deploy. */
	DISPATCH?: DispatchNamespace;
	/** Cloudflare account that owns the dispatch namespace (REST uploads). */
	CF_ACCOUNT_ID?: string;
	/** API token with Workers Scripts edit, scoped to namespace operations. */
	CF_HOSTING_API_TOKEN?: string;
	/** Namespace NAME for the REST API - the binding does not reveal it. */
	DISPATCH_NAMESPACE?: string;
	/** Apex domain apps serve under; empty disables the serving path. */
	HOSTING_DOMAIN?: string;
	/** Pass outbound parameters at dispatch - set only beside an `outbound`
	 * block in the namespace binding, because they throw without one. */
	DISPATCH_OUTBOUND?: 'true';
	/** Where the bare apex redirects; without it the apex answers 404. */
	HOSTING_APEX_REDIRECT?: string;
	/** Record deploys and serve a stub page instead of calling Cloudflare -
	 * local dev and e2e, where dynamic upload has no simulator. */
	HOSTING_STUB?: 'true';
	/** Master key for build secrets (AES-GCM at rest, src/crypto.ts). Optional:
	 * without it build-secret writes answer 503 and everything else works. */
	HOSTING_MASTER_KEY?: string;
	/** Per-request analytics writes from the serve path. Optional: Analytics
	 * Engine is an account-level opt-in (see wrangler.jsonc); unset, writes
	 * are skipped and nothing else changes. */
	HOSTING_REQUESTS?: AnalyticsEngineDataset;
	/** Dataset NAME for the SQL read API - the binding does not reveal it. */
	WAE_DATASET?: string;
	/** Account Analytics Read token; with CF_ACCOUNT_ID it unlocks the
	 * analytics tab's reads. Optional - without it the tab reports write-only. */
	CF_ANALYTICS_API_TOKEN?: string;
	/** Local-dev stand-in: with no read credentials, served requests land in
	 * this D1 and the analytics endpoint reads them back. */
	LOCAL_ANALYTICS?: D1Database;
	SENTRY_DSN?: string;
	SENTRY_ENV?: string;

	/**
	 * Serves the agent's own routes (`/overview`, `/apps/*`, `/deploys`, the
	 * state-sync socket, `/internal/*`) over HTTP. Every one of them deploys
	 * code, mints subdomains, or writes secrets, and none authenticate a
	 * caller - set this only on a Worker with no public hostname, fronted by
	 * something that authenticates operators.
	 *
	 * Unset (the default, and what `template/wrangler-fragment.jsonc` ships)
	 * they 404. Serving deployed apps on the wildcard hostname is unaffected,
	 * and your own code reaches the agent through the Durable Object namespace
	 * either way.
	 */
	EXPOSE_OPERATOR_API?: 'true';
}

export type AssertHostingAgentEnv<E extends HostingAgentBindings> = E;
