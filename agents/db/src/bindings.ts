/**
 * The binding contract a consumer's Worker must satisfy to host this agent.
 *
 * `AssertDbAgentEnv<Env>` is an identity type whose CONSTRAINT does the
 * checking: instantiating it with a deficient Env names the missing or
 * mistyped binding at the use site, at compile time. The consumer's `Env` is
 * the ambient interface `wrangler types` generates - never a hand-written
 * one (the Agents SDK constrains against `Cloudflare.Env`, which only the
 * generated types merge into).
 *
 * `DurableObjectNamespace<any>` is deliberate: the namespace type is
 * effectively invariant, so `never` and `unknown` each fail one direction of
 * assignability against a consumer's concrete class.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDurableObjectNamespace = DurableObjectNamespace<any>;

export interface DbAgentBindings {
	/** The per-project coordinator class. Required. */
	DbAgent: AnyDurableObjectNamespace;
	/** The per-collection store class. Required. */
	DbCollection: AnyDurableObjectNamespace;
	/** The per-table store class (typed columns, ORM-compatible). Required. */
	DbTable: AnyDurableObjectNamespace;
	/** The realtime gateway class (one client socket, all shards). Required. */
	DbGateway: AnyDurableObjectNamespace;
	/** Document/collection events; auto-creates on first write. Required. */
	DB_EVENTS: AnalyticsEngineDataset;

	/**
	 * JWKS sources for verifying auth-agent project JWTs, both optional:
	 * AUTH_AGENT is a service binding to a separate auth worker; AuthAgent is
	 * the Durable Object namespace present when `add auth` put both agents in
	 * one Worker. With neither, token-gated collections fail closed with 503
	 * and public collections work untouched.
	 */
	AUTH_AGENT?: Fetcher;
	AuthAgent?: AnyDurableObjectNamespace;

	/** Comma-separated EXTRA trusted origins; own origin is automatic. */
	TRUSTED_ORIGINS?: string;
	SENTRY_DSN?: string;
	SENTRY_ENV?: string;
	/** Test stacks only: honor x-cfb-region for deterministic region routing. */
	REGION_OVERRIDE_HEADER?: string;
	/** Local/test analytics mirror; production uses DB_EVENTS alone. */
	LOCAL_ANALYTICS?: D1Database;
	DEMO_MODE?: 'true';
	DEMO_TTL_HOURS?: string;
}

export type AssertDbAgentEnv<E extends DbAgentBindings> = E;
