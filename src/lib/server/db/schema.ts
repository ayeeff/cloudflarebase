import { sql } from 'drizzle-orm';
import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex
} from 'drizzle-orm/sqlite-core';

/**
 * Control-plane schema, held in D1 on the dashboard Worker.
 *
 * This is deliberately not in an agent. The registry lists projects, and a
 * project will eventually have a db agent and a storage agent as well as auth
 * - so no single agent can own it without every other agent depending on that
 * one. D1 binds directly to the dashboard, which is the control plane, and
 * needs no Durable Object (the SvelteKit adapter cannot export one anyway).
 */
export const project = sqliteTable(
	'project',
	{
		/** Becomes the Durable Object name and the API base path. Immutable.
		 * A BRANCH row's id is `<parentId>--<branchName>` - the derived id IS
		 * the isolation (docs/branches-design.md): every agent already keys on
		 * project id, so a branch gets its own instances, keys, and replicas
		 * with zero agent changes. */
		id: text('id').primaryKey(),
		name: text('name').notNull(),
		/** Root project this row branches from; null = a root project. The
		 * registry decides what is a branch - never the string shape (ids
		 * containing `--` from before the rule are grandfathered roots). */
		parentId: text('parent_id'),
		/** The branch's short name (`staging`); null on roots (`main`). */
		branchName: text('branch_name'),
		/** Owning organization - a row in the console AuthAgent's org tables
		 * (docs/managed-service-design.md). The registry knows which org owns a
		 * project; the agent knows who is in the org; the guard joins the two
		 * per request. Null = legacy/self-hosted row, visible to any operator -
		 * exactly the pre-Phase-A behaviour, so a claimed-mode install never
		 * notices ownership exists. Branch rows copy the root's value. */
		orgId: text('org_id'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
	},
	(table) => [
		index('project_created_at').on(table.createdAt),
		index('project_parent').on(table.parentId),
		index('project_org').on(table.orgId)
	]
);

export type ProjectRow = typeof project.$inferSelect;

/**
 * Append-only log of demo projects, written when the dashboard mints a
 * `demo-<hex>` id for an anonymous visitor. Demo Durable Objects self-erase
 * after DEMO_TTL_HOURS and their auth events age out of Analytics Engine after
 * 90 days, so this log is the only all-time record - the fleet dashboard reads
 * its count as the "demos created" total. Rows are never deleted.
 */
export const demoProject = sqliteTable(
	'demo_project',
	{
		id: text('id').primaryKey(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
	},
	(table) => [index('demo_project_created_at').on(table.createdAt)]
);

/**
 * Copilot conversation history. The tool-calling loop runs in this Worker (it
 * reads BOTH agents over the service bindings), so its transcript is
 * control-plane state, not any one agent's. `client_key` is the operator's
 * user id, or a project-scoped SHA-256 of the connecting IP for anonymous
 * demo visitors - raw IPs are never stored.
 */
export const chatMessage = sqliteTable(
	'chat_message',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id').notNull(),
		clientKey: text('client_key').notNull(),
		role: text('role').$type<'user' | 'agent'>().notNull(),
		content: text('content').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
	},
	(table) => [index('chat_message_thread').on(table.projectId, table.clientKey, table.createdAt)]
);

/**
 * Hosting subdomain claims (docs/managed-service-design.md, Phase B). The
 * dispatch namespace is global, so claims are control-plane state - no agent
 * may own the namespace without every project depending on that one instance.
 * One row per project+app: `project_id` is the FULL registry id (a branch is
 * its own registry row, so it is its own claim row), and `subdomain` is what
 * was ACTUALLY claimed under the auto-numbering rule - persisted on first
 * claim and reused verbatim, never re-derived, so URLs stay stable when
 * neighboring claims appear or are released.
 */
export const app = sqliteTable(
	'app',
	{
		/** The claimed subdomain of cfbase.dev; also the dispatch script name. */
		subdomain: text('subdomain').primaryKey(),
		projectId: text('project_id').notNull(),
		/** The operator-chosen app name the subdomain was derived from. */
		appName: text('app_name').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
	},
	(table) => [index('app_project').on(table.projectId, table.appName)]
);

export type AppRow = typeof app.$inferSelect;

/**
 * Project-scoped deploy tokens (docs/managed-service-design.md, Phase B) -
 * the durable credential CI deploys ride, minted on ROOT projects and valid
 * for the root and its branches. Only the SHA-256 digest is stored, so a
 * control-plane leak never yields a working credential; the guard accepts
 * the `cfbd_` bearer solely on the deploy and branch-create endpoints.
 */
export const deployToken = sqliteTable(
	'deploy_token',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id').notNull(),
		name: text('name').notNull(),
		tokenHash: text('token_hash').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' })
	},
	(table) => [
		index('deploy_token_project').on(table.projectId),
		index('deploy_token_hash').on(table.tokenHash)
	]
);

export type DeployTokenRow = typeof deployToken.$inferSelect;

/**
 * Project service keys (docs/service-keys-design.md) - the credential a SERVER
 * can hold, for the cases with no user to relay: crons, queue consumers,
 * webhook handlers, seed scripts, and backends we do not host.
 *
 * Scoped to ONE registry row, deliberately NOT to the root-and-branches family
 * deploy tokens use: for data the branch IS the isolation boundary, and a
 * preview key that reached production rows would make branches a lie.
 *
 * Only the SHA-256 digest is stored, so a control-plane leak yields no working
 * credential, and the secret is unrecoverable after the one-time reveal.
 */
export const serviceKey = sqliteTable(
	'service_key',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id').notNull(),
		name: text('name').notNull(),
		keyHash: text('key_hash').notNull(),
		/** Operator user id, so a key has an author in the audit trail. */
		createdBy: text('created_by'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' })
	},
	(table) => [
		index('service_key_project').on(table.projectId),
		index('service_key_hash').on(table.keyHash)
	]
);

export type ServiceKeyRow = typeof serviceKey.$inferSelect;

/**
 * GitHub App installations, bound to the console org that installed them.
 *
 * The binding is what stops one operator connecting another account's repo:
 * `installation_id` arrives from GitHub on a redirect the operator controls,
 * so it is only trustworthy at the moment the signed install `state` comes
 * back. The callback records the binding once; every later connect checks it
 * instead of trusting the id again. Null `org_id` matches a null-org project
 * (legacy/self-hosted rows, already visible to any operator).
 */
export const githubInstallation = sqliteTable(
	'github_installation',
	{
		/** GitHub's numeric installation id - the unit access tokens are minted for. */
		id: integer('id').primaryKey(),
		orgId: text('org_id'),
		/** The GitHub account the App is installed on (`acme`), for display. */
		accountLogin: text('account_login').notNull(),
		/** Console user id that completed the install - audit, and the fallback
		 * owner when the project carries no org. */
		installedBy: text('installed_by').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
	},
	(table) => [index('github_installation_org').on(table.orgId)]
);

export type GithubInstallationRow = typeof githubInstallation.$inferSelect;

/**
 * A repository connected to one project+app - the push-to-deploy link.
 *
 * Minted on a ROOT project and valid for its branches, exactly like a deploy
 * token: a push to the default branch deploys the root, any other branch
 * deploys `<root>--<branch>`. Two modes, chosen per connection:
 *
 * - `build` writes `.github/workflows/cloudflarebase.yml` into the repo and
 *   trusts the Actions OIDC token it presents. GitHub's runners do the build;
 *   we run no build farm and hold no repo secret.
 * - `direct` needs no runner and no file in the repo at all: the push webhook
 *   hands the pushed tree straight to the hosting agent. Only viable when
 *   there is nothing to build, which is why `assets_dir` is captured here.
 *
 * `repo_id` is the numeric id, not the name: repositories get renamed and the
 * webhook must still find its connection. `repo_full_name` is what the OIDC
 * `repository` claim is matched against, and is re-synced from webhook
 * payloads so a rename cannot silently break build-mode trust.
 */
export const githubConnection = sqliteTable(
	'github_connection',
	{
		id: text('id').primaryKey(),
		/** The ROOT project; branches ride the same connection. */
		projectId: text('project_id').notNull(),
		appName: text('app_name').notNull(),
		installationId: integer('installation_id').notNull(),
		repoId: integer('repo_id').notNull(),
		repoFullName: text('repo_full_name').notNull(),
		defaultBranch: text('default_branch').notNull(),
		mode: text('mode').$type<'build' | 'direct'>().notNull(),
		/** Direct mode: repo-relative directory published as assets ('' = root).
		 * Build mode: where the build lands (null = CLI autodetects). */
		assetsDir: text('assets_dir'),
		/** Build mode: the workflow's build command (framework preset or
		 * operator-edited); null = the generic `npm run build --if-present`. */
		buildCommand: text('build_command'),
		/** Build mode: monorepo root - install/build/deploy run here.
		 * Null = repository root. */
		rootDir: text('root_dir'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		/** Last push we accepted - the Hosting page's "last deploy from GitHub". */
		lastEventAt: integer('last_event_at', { mode: 'timestamp_ms' })
	},
	(table) => [
		// One repo per app. Not unique on repo_id: the same repository legitimately
		// deploys to several projects (a monorepo, or prod and a scratch project).
		uniqueIndex('github_connection_app').on(table.projectId, table.appName),
		index('github_connection_repo').on(table.repoId),
		index('github_connection_installation').on(table.installationId)
	]
);

export type GithubConnectionRow = typeof githubConnection.$inferSelect;

/**
 * Which agents a project has enabled. Groundwork from the agent contract: v1
 * default-enables every registry agent and offers no opt-out UI, and deletion
 * deliberately does NOT read this table - erase fans out to every registry
 * agent even when a row is missing, so a gap can never strand user data.
 */
export const projectAgent = sqliteTable(
	'project_agent',
	{
		projectId: text('project_id').notNull(),
		agent: text('agent').notNull(),
		enabledAt: integer('enabled_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
	},
	(table) => [primaryKey({ columns: [table.projectId, table.agent] })]
);
