/**
 * Compile-time contract test, executed by `tsc --noEmit` (excluded from the
 * publish build). The @ts-expect-error negatives fail the typecheck in BOTH
 * directions: weakening the contract makes a suppression unused, which
 * TypeScript reports.
 */
import type { AssertHostingAgentEnv } from './bindings';

// This repository's own generated Env satisfies the contract.
type _SelfCheck = AssertHostingAgentEnv<Env>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNamespace = DurableObjectNamespace<any>;

// The minimal correct deployment: just the Durable Object namespace.
type _Minimal = AssertHostingAgentEnv<{ HostingAgent: AnyNamespace }>;

// A fully configured deployment.
type _Full = AssertHostingAgentEnv<{
	HostingAgent: AnyNamespace;
	DISPATCH: DispatchNamespace;
	CF_ACCOUNT_ID: string;
	CF_HOSTING_API_TOKEN: string;
	DISPATCH_NAMESPACE: string;
	HOSTING_DOMAIN: string;
	DISPATCH_OUTBOUND: 'true';
	HOSTING_APEX_REDIRECT: string;
	HOSTING_STUB: 'true';
	SENTRY_DSN: string;
	SENTRY_ENV: string;
}>;

// @ts-expect-error - the Durable Object namespace is required.
type _MissingAgent = AssertHostingAgentEnv<{ DISPATCH: DispatchNamespace }>;

// @ts-expect-error - DISPATCH must be a dispatch namespace, not a Fetcher.
type _WrongDispatch = AssertHostingAgentEnv<{ HostingAgent: AnyNamespace; DISPATCH: Fetcher }>;

// @ts-expect-error - vars are strings.
type _WrongOptional = AssertHostingAgentEnv<{ HostingAgent: AnyNamespace; HOSTING_DOMAIN: number }>;

export type {};
