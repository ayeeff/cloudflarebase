import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * HostingAgent storage: the per-project app registry, deploy history, and
 * per-app environment. Control plane, not data plane - the code and assets
 * live in the dispatch namespace; these rows are what the dashboard lists and
 * what erase walks.
 */

/** Apps this project has deployed. `subdomain` is pushed by the console after
 * it resolves the claim (the control plane owns the global namespace); the
 * agent never derives one. */
export const apps = sqliteTable('apps', {
	name: text('name').primaryKey(),
	subdomain: text('subdomain').notNull(),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	lastDeployAt: integer('last_deploy_at', { mode: 'timestamp_ms' }),
	deployCount: integer('deploy_count').notNull().default(0),
	/** JSON snapshot of the CLI's `meta.vars` from the most recent deploy.
	 * Editing a var in the console replaces the script's WHOLE plain_text set,
	 * so the patch must reconstitute platform > stored > CLI without the CLI
	 * present - without this snapshot a console edit would silently drop every
	 * CLI-declared var from the live script. */
	lastDeployVars: text('last_deploy_vars'),
});

export type AppRecord = typeof apps.$inferSelect;

export const deploys = sqliteTable('deploys', {
	id: text('id').primaryKey(),
	appName: text('app_name').notNull(),
	subdomain: text('subdomain').notNull(),
	/** `live` = uploaded to the namespace; `stub` = recorded under HOSTING_STUB. */
	status: text('status').$type<'live' | 'stub'>().notNull(),
	/** Whether the deploy carried a Worker module (vs assets-only). */
	hasWorker: integer('has_worker', { mode: 'boolean' }).notNull(),
	assetCount: integer('asset_count').notNull(),
	assetBytes: integer('asset_bytes').notNull(),
	moduleBytes: integer('module_bytes').notNull(),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export type DeployRecord = typeof deploys.$inferSelect;

/** Runtime plain-text vars, stored per app: applied as `plain_text` bindings
 * on every deploy and patched onto the live script when edited. Plaintext at
 * rest on purpose - they upload as plain_text bindings anyway, and DO storage
 * is the trust boundary (the storage agent's signing secret precedent). */
export const appVars = sqliteTable(
	'app_vars',
	{
		appName: text('app_name').notNull(),
		name: text('name').notNull(),
		value: text('value').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
	},
	(table) => [primaryKey({ columns: [table.appName, table.name] })],
);

export type AppVarRecord = typeof appVars.$inferSelect;

/** Runtime secret NAMES only. Values are write-through to Cloudflare's script
 * settings and never at rest here - these rows exist so the console can list
 * and delete what was set. */
export const appSecrets = sqliteTable(
	'app_secrets',
	{
		appName: text('app_name').notNull(),
		name: text('name').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
	},
	(table) => [primaryKey({ columns: [table.appName, table.name] })],
);

export type AppSecretRecord = typeof appSecrets.$inferSelect;

/** Build-time vars, fetched by the GitHub Actions workflow before the build
 * step. Connection-scoped: they live in the ROOT project's agent only, and
 * every branch build of the connection reads the same set. */
export const buildVars = sqliteTable(
	'build_vars',
	{
		appName: text('app_name').notNull(),
		name: text('name').notNull(),
		value: text('value').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
	},
	(table) => [primaryKey({ columns: [table.appName, table.name] })],
);

export type BuildVarRecord = typeof buildVars.$inferSelect;

/** Build-time secrets - the one value Cloudflarebase stores AND must recover
 * (the runner fetches it at build time), so it is AES-GCM ciphertext under
 * `HOSTING_MASTER_KEY` (src/crypto.ts), never plaintext at rest. */
export const buildSecrets = sqliteTable(
	'build_secrets',
	{
		appName: text('app_name').notNull(),
		name: text('name').notNull(),
		ciphertext: text('ciphertext').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
	},
	(table) => [primaryKey({ columns: [table.appName, table.name] })],
);

export type BuildSecretRecord = typeof buildSecrets.$inferSelect;
