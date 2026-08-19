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
	/** Spelled out rather than importing AccessMode: this file is the drizzle
	 * schema and stays free of the boundary schemas. Widening it is metadata
	 * only - the column is TEXT either way, so no migration is involved. */
	readAccess: text('read_access')
		.$type<'public' | 'auth' | 'owner' | 'none'>()
		.notNull()
		.default('auth'),
	writeAccess: text('write_access')
		.$type<'public' | 'auth' | 'owner' | 'none'>()
		.notNull()
		.default('auth'),
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

/**
 * StorageAgent: open multipart uploads, which are RESERVATIONS as much as
 * records. An in-flight upload has bytes landing in R2 that no index row
 * counts yet, so without a reservation a project could start ten uploads that
 * each individually fit under the quota and collectively blow past it.
 * `getBucketAccess` folds the open total into its verdict, which is how
 * single-shot PUTs see them too.
 *
 * It lives on the PARENT rather than the bucket index because create needs
 * facts only the parent holds - the project byte total and the concurrent
 * count - and because the sweep would otherwise need a cross-DO join. The
 * traffic is per FILE (create/complete/abort/sweep), never per part.
 */
export const uploads = sqliteTable(
	'uploads',
	{
		/** Our reservation id, not R2's - the R2 id travels only inside the
		 * signed envelope, since resumeMultipartUpload() validates nothing. */
		id: text('id').primaryKey(),
		bucket: text('bucket').notNull(),
		key: text('key').notNull(),
		r2UploadId: text('r2_upload_id').notNull(),
		partSize: integer('part_size').notNull(),
		/** Declared size, held against the project quota until settled. */
		reservedBytes: integer('reserved_bytes').notNull(),
		contentType: text('content_type').notNull().default('application/octet-stream'),
		owner: text('owner').notNull().default(''),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	},
	(table) => [
		// The sweep pages by age; the console lists a bucket's open uploads.
		index('uploads_created_idx').on(table.createdAt),
		index('uploads_bucket_idx').on(table.bucket),
	],
);

export type UploadRecord = typeof uploads.$inferSelect;
