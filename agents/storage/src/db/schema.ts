import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * ONE drizzle pipeline for both classes (the db-agent precedent): StorageAgent
 * and StorageBucket apply the same inlined migrations idempotently, and the
 * tables a class does not use simply stay empty.
 *
 * R2 is the source of truth for BYTES; these rows are metadata. The parent's
 * `buckets` table is the per-project bucket registry and access config; the
 * child's `objects` table is the per-bucket index - the only way to sort,
 * filter, count, or page a bucket, since R2 list() is prefix-ordered with no
 * sort or filter.
 */

/** StorageAgent: the project's buckets, their access config, and debounced
 * absolute counters reported by each bucket's index as a heartbeat. */
export const buckets = sqliteTable('buckets', {
	name: text('name').primaryKey(),
	readAccess: text('read_access').$type<'public' | 'auth' | 'owner'>().notNull().default('auth'),
	writeAccess: text('write_access').$type<'public' | 'auth' | 'owner'>().notNull().default('auth'),
	readPermission: text('read_permission'),
	writePermission: text('write_permission'),
	/** Enumeration is a separate grant from reading a known key. */
	publicListing: integer('public_listing', { mode: 'boolean' }).notNull().default(false),
	/** Per-object ceiling; null means the deployment default applies. */
	maxObjectBytes: integer('max_object_bytes'),
	/** Write-time content-type allowlist; null means any type. */
	allowedContentTypes: text('allowed_content_types', { mode: 'json' }).$type<string[] | null>(),
	/** Cache-Control for public reads; null means the short default. */
	cacheControl: text('cache_control'),
	/** Monotonic, bumped on every config edit - a stale push can never
	 * regress a child or an isolate cache. */
	configVersion: integer('config_version').notNull().default(1),
	objectCount: integer('object_count').notNull().default(0),
	totalBytes: integer('total_bytes').notNull().default(0),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export type BucketRecord = typeof buckets.$inferSelect;

/** StorageBucket: one row per stored object - the sorted, pageable index. */
export const objects = sqliteTable(
	'objects',
	{
		/** The user key (unprefixed - the R2 prefix is derivable, never stored). */
		key: text('key').primaryKey(),
		size: integer('size').notNull(),
		etag: text('etag').notNull(),
		contentType: text('content_type').notNull().default('application/octet-stream'),
		/** JWT subject that wrote the object; empty for public/operator writes. */
		owner: text('owner').notNull().default(''),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
	},
	(table) => [
		// Owner-scoped listings (owner access mode) page by owner + key.
		index('objects_owner_key_idx').on(table.owner, table.key),
	],
);

export type ObjectRecord = typeof objects.$inferSelect;
