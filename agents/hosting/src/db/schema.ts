import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * HostingAgent storage: the per-project app registry and deploy history.
 * Control plane, not data plane - the code and assets live in the dispatch
 * namespace; these rows are what the dashboard lists and what erase walks.
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
