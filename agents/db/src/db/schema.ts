import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * One drizzle pipeline serves BOTH Durable Object classes: DbAgent (the
 * per-project coordinator) uses `collections`; DbCollection (one instance per
 * collection) uses `documents`, `subscriptions`, and `collection_meta`.
 * Migrations apply idempotently in each class, so tables a class never
 * touches simply stay empty - simpler than two drizzle configs. Revisit only
 * if the two schemas diverge heavily.
 */

/**
 * DbAgent only: the authoritative shard registry for one project - both
 * kinds. `name` stays the sole primary key, so a name is unique ACROSS
 * collections and tables (changing the PK would force a table rebuild
 * migration; global uniqueness is also simply less confusing). `kind`
 * discriminates; `columns` carries the declared column DSL for tables and
 * stays null for collections, `validator` the inverse.
 */
export const collections = sqliteTable('collections', {
	name: text('name').primaryKey(),
	/** 'collection' | 'table' */
	kind: text('kind').notNull().default('collection'),
	readAccess: text('read_access').notNull().default('auth'),
	writeAccess: text('write_access').notNull().default('auth'),
	/** Permission key the JWT must carry to read/write; null = mode alone. */
	readPermission: text('read_permission'),
	writePermission: text('write_permission'),
	/** JSON CollectionValidator; null = no document rules. Collections only. */
	validator: text('validator'),
	/** JSON TableColumn[]; the declared schema of record. Tables only. */
	columns: text('columns'),
	/** 'off' | 'auto' - whether reads route to per-region replicas. */
	replication: text('replication').notNull().default('off'),
	/** Parent-owned restore epoch; bumped after PITR so replicas re-bootstrap. */
	repEpoch: integer('rep_epoch').notNull().default(0),
	/** Last count reported by the child (docs or rows); the child's own
	 * count is exact. */
	docs: integer('docs').notNull().default(0),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	reportedAt: integer('reported_at', { mode: 'timestamp_ms' }),
});

/** DbCollection only: the documents of ONE collection. */
export const documents = sqliteTable(
	'documents',
	{
		id: text('id').primaryKey(),
		/** JSON text; queried with json_extract. */
		data: text('data').notNull(),
		/** jwt.sub stamped by owner-mode writes; null elsewhere. */
		owner: text('owner'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
	},
	(table) => [
		index('documents_updated_at').on(table.updatedAt),
		index('documents_owner').on(table.owner),
	],
);

/**
 * DbCollection only: live-query subscriptions. The WebSocket attachment
 * holds nothing but the connection id - THIS table is what survives
 * hibernation, so a woken instance restores full context from SQLite.
 */
export const subscriptions = sqliteTable(
	'subscriptions',
	{
		connId: text('conn_id').notNull(),
		subId: text('sub_id').notNull(),
		/** Canonical Query JSON (no cursor). */
		query: text('query').notNull(),
		/** Owner-mode filter: results restricted to owner = ownerSub. */
		ownerSub: text('owner_sub'),
		/** JWT exp (epoch seconds); null = public subscription. Lazy-checked. */
		tokenExp: integer('token_exp'),
		/** JSON id[] of the last delivered window - orderBy+limit queries only. */
		lastMembership: text('last_membership'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.connId, table.subId] }),
		index('subscriptions_conn').on(table.connId),
	],
);

/**
 * DbAgent only: captured PITR bookmarks per collection - the D1-Time-Travel
 * style restore points the dashboard lists. Bookmarks come from the child's
 * storage back-end; rows older than the platform's 30-day window are pruned
 * on read, and a collection delete drops its rows.
 */
export const restorePoints = sqliteTable(
	'restore_points',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		collection: text('collection').notNull(),
		bookmark: text('bookmark').notNull(),
		/** e.g. manual checkpoint | before import | before rollback */
		reason: text('reason').notNull(),
		capturedAt: integer('captured_at', { mode: 'timestamp_ms' }).notNull(),
	},
	(table) => [index('restore_points_collection').on(table.collection)],
);

/** DbCollection only: single-row cached config pushed from the parent. */
export const collectionMeta = sqliteTable('collection_meta', {
	/** Always 1. */
	id: integer('id').primaryKey(),
	/** JSON CollectionConfig. */
	config: text('config').notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

/**
 * PRIMARY role (both shard classes): the replication change log. Row images,
 * never statements - `put` carries the full DTO JSON, `del` a tombstone,
 * `cfg` the shard config (so mode changes and table DDL replicate in write
 * order). Written in the same task as the data mutation (DO write coalescing
 * commits them atomically) and pruned to MAX_LOG_ROWS; replicas behind the
 * horizon are forced to re-bootstrap.
 */
export const changelog = sqliteTable('changelog', {
	lsn: integer('lsn').primaryKey({ autoIncrement: true }),
	/** 'put' | 'del' | 'cfg' */
	op: text('op').notNull(),
	id: text('id').notNull(),
	image: text('image'),
	ts: integer('ts', { mode: 'timestamp_ms' }).notNull(),
});

/**
 * PRIMARY role: every replica that has ever pulled, registered DURABLY
 * before it is served data - the erase fan-out iterates this table, so no
 * replica holding data can be unknown to its primary.
 */
export const replicas = sqliteTable('replicas', {
	/** The instance-name suffix, e.g. `r:weur:1`. */
	id: text('id').primaryKey(),
	region: text('region').notNull(),
	appliedLsn: integer('applied_lsn').notNull().default(0),
	lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
});

/** REPLICA role: single-row applied position and freshness bookkeeping. */
export const replicaMeta = sqliteTable('replica_meta', {
	/** Always 1. */
	id: integer('id').primaryKey(),
	epoch: integer('epoch').notNull().default(0),
	appliedLsn: integer('applied_lsn').notNull().default(0),
	pulledAt: integer('pulled_at', { mode: 'timestamp_ms' }).notNull(),
});
