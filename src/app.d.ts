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
			/**
			 * Deploy-token grant when the request authenticated with a `cfbd_`
			 * bearer (Phase B). Only ever set on
			 * the deploy and branch-create endpoints; never a session.
			 */
			deployToken: import('$lib/server/hosting').DeployTokenGrant | null;
			/**
			 * Grant when the request authenticated with a GitHub Actions OIDC
			 * token from a `build`-mode connection - the credential-less CI path.
			 * Set on exactly the same surfaces as `deployToken`, never a session.
			 */
			githubDeploy: import('$lib/server/github-connect').GithubDeployGrant | null;
			/**
			 * Grant when the request authenticated with a `cfbs_` service key
			 *. Set only on its own project's DATA
			 * plane, and only when the request carried no `Origin` - a service
			 * key is a server credential and must never work from a browser.
			 */
			serviceKey: import('$lib/server/service-keys').ServiceKeyGrant | null;
		}

		interface Platform {
			env: Env & {
				/** Service binding to the auth-agent worker (fetch-only interface). */
				AUTH_AGENT: Fetcher;
				/** Service binding to the db-agent worker (fetch-only interface). */
				DB_AGENT: Fetcher;
				/** Service binding to the hosting-agent worker (fetch-only interface). */
				HOSTING_AGENT: Fetcher;
				/**
				 * Service binding to the geo-astro-site Worker — reaches the geo-site
				 * admin APIs for the /dashboard/geo-site/content/* pages without the
				 * edge-blocked workers.dev subrequest.
				 */
				GEO_ASTRO: Fetcher;
				/**
				 * Service binding to the `update` Worker (the weekly World Bank refresh
				 * cron for /maps/global-population + /maps/global-gdp) — powers the
				 * /admin/update tab's status panel and manual-refresh button.
				 */
				UPDATE_WORKER: Fetcher;
				/**
				 * Optional per-tenant ceiling overrides (registry.ts defaults both
				 * to 5). Not in any deployed config's vars, so they are typed here
				 * instead of the generated worker-configuration.d.ts; the e2e stack
				 * raises the org ceiling because reused suites accumulate projects.
				 */
				MAX_PROJECTS_PER_ORG?: string;
				MAX_BRANCHES_PER_ROOT?: string;
				/**
				 * GitHub App credentials for push-to-deploy (server/github.ts).
				 * Optional secrets - typed here rather than in the generated
				 * worker-configuration.d.ts because no deployed config declares
				 * them. All four together or the App reads as unconfigured, which
				 * is the self-hosted default: the Hosting page then offers the
				 * manual deploy-token flow and nothing GitHub-side is reachable.
				 * The private key may be either PEM encoding GitHub hands out.
				 */
				GITHUB_APP_ID?: string;
				GITHUB_APP_SLUG?: string;
				GITHUB_APP_PRIVATE_KEY?: string;
				GITHUB_APP_WEBHOOK_SECRET?: string;
			};
			cf: CfProperties;
			ctx: ExecutionContext;
		}
	}
}

export {};
