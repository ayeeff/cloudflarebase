// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		interface Locals {
			/**
			 * Operator session for the console, resolved once per request by the
			 * guard in hooks.server.ts. Null for anonymous demo traffic.
			 */
			consoleUser: import('$lib/server/console').ConsoleUser | null;
			/**
			 * The operator's full identity - session plus org memberships and
			 * pending invitations - from the console agent's /console/me, resolved
			 * once per request alongside consoleUser. The guard's ownership check
			 * and the org UI both read this instead of re-fetching.
			 */
			consoleIdentity: import('$lib/console').ConsoleIdentity | null;
			/** Whether this deployment runs as a public demo (DEMO_MODE=true). */
			demoMode: boolean;
		}

		interface Platform {
			env: Env & {
				/** Service binding to the auth-agent worker (fetch-only interface). */
				AUTH_AGENT: Fetcher;
				/** Service binding to the db-agent worker (fetch-only interface). */
				DB_AGENT: Fetcher;
			};
			cf: CfProperties;
			ctx: ExecutionContext;
		}
	}
}

export {};
