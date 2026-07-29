import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
		/** Becomes the Durable Object name and the API base path. Immutable. */
		id: text('id').primaryKey(),
		name: text('name').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`)
	},
	(table) => [index('project_created_at').on(table.createdAt)]
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
