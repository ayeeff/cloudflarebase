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
