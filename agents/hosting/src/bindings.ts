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
	SENTRY_DSN?: string;
	SENTRY_ENV?: string;
}

export type AssertHostingAgentEnv<E extends HostingAgentBindings> = E;
