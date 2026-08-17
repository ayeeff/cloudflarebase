import { DurableObject } from 'cloudflare:workers';
import { and, asc, count, eq, gt, sql, sum } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import * as schema from './db/schema';
import { objects, type ObjectRecord } from './db/schema';
import migrations from './migrations';
import type { StorageAgent } from './agent';

/**
 * StorageBucket - one plain Durable Object per bucket (`<projectId>:<bucket>`),
 * holding the OBJECT INDEX: one row per key. R2 owns the bytes; this owns
 * everything R2's list() cannot do - sorted keyset paging, counts, owner
 * scoping, and the counters the parent's quota checks read.
 *
 * A plain DurableObject, deliberately not an SDK Agent, for the DbCollection
 * reason: it is addressed by anonymous public traffic (via the worker), and
 * SDK state-sync frames would leak operator data onto that path.
 *
 * Bytes never enter this object. The worker streams to R2 and calls the
 * small metadata RPCs here afterwards; the row wants the put's REAL size and
 * etag, which is why writes go to R2 first (see "Index consistency" in
 * docs/storage-agent-plan.md - deletes also go to R2 first, so a crash can
 * only ever leave the benign phantom-row shape, never an unindexed orphan
 * that bills forever, on the delete path).
 */

/** How often the child reports absolute counters to the parent. A heartbeat,
 * not a change notification - in-memory debounce, so the first write after a
 * hibernation wake always reports. */
const STATS_REPORT_INTERVAL_MS = 5_000;

export interface BucketIdentity {
	projectId: string;
	bucket: string;
}

export interface ObjectMeta {
	key: string;
	size: number;
	etag: string;
	contentType: string;
	owner: string;
}

export interface ObjectSummary {
	key: string;
	size: number;
	etag: string;
	contentType: string;
	owner: string;
	createdAt: string;
	updatedAt: string;
}

export interface ListObjectsInput {
	prefix?: string;
	cursor?: string;
	limit?: number;
	/** Restrict to one owner's rows (`owner` access mode listings). */
	owner?: string;
	/** `/` collapses everything below the next separator into folders. Absent
	 * lists the whole subtree flat, which is what the SDK's default does. */
	delimiter?: '/';
}

/** One collapsed folder: the prefix INCLUDING its trailing separator, plus how
 * many indexed objects live under it (at any depth). */
export interface FolderSummary {
	prefix: string;
	objectCount: number;
}

export interface ListObjectsResult {
	objects: ObjectSummary[];
	total: number;
	cursor: string | null;
	/** Only present for a delimited listing. */
	folders?: FolderSummary[];
	/** True when more folders exist than were returned - said out loud rather
	 * than silently truncated, because a browser that quietly drops folders
	 * looks like data loss. */
	foldersTruncated?: boolean;
}

export interface BucketStats {
	objectCount: number;
	totalBytes: number;
}

function toSummary(row: ObjectRecord): ObjectSummary {
	return {
		key: row.key,
		size: row.size,
		etag: row.etag,
		contentType: row.contentType,
		owner: row.owner,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

/** LIKE pattern for "starts with", with the wildcards in USER data escaped -
 * a prefix containing `%` or `_` must match literally, not as a wildcard. */
function prefixPattern(prefix: string): string {
	return `${prefix.replace(/([\\%_])/g, '\\$1')}%`;
}

export class StorageBucket extends DurableObject<Env> {
	db: DrizzleSqliteDODatabase<typeof schema>;
	private migrated = false;
	private identityStored = false;
	private lastStatsReport = 0;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = drizzle(ctx.storage, { schema });
	}

	/** Idempotent - drizzle tracks applied migrations in its own table. */
	private async ensureMigrated(): Promise<void> {
		if (this.migrated) return;
		await migrate(this.db, migrations);
		this.migrated = true;
	}

	/** A plain DO cannot read its own name, so the worker carries the identity
	 * on every write RPC; stored once so the stats heartbeat can dial the
	 * parent after a hibernation wake. */
	private async ensureIdentity(identity: BucketIdentity): Promise<void> {
		if (this.identityStored) return;
		await this.ctx.storage.put('bucket-meta', identity);
		this.identityStored = true;
	}

	/** Records a completed R2 put. Upsert: overwrites refresh size/etag/owner
	 * and keep createdAt. Returns the fresh counters so the caller can spot a
	 * bucket crossing its ceiling without a second RPC. */
	async recordPut(identity: BucketIdentity, meta: ObjectMeta): Promise<BucketStats> {
		await this.ensureMigrated();
		await this.ensureIdentity(identity);
		const now = new Date();
		await this.db
			.insert(objects)
			.values({
				key: meta.key,
				size: meta.size,
				etag: meta.etag,
				contentType: meta.contentType,
				owner: meta.owner,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: objects.key,
				set: {
					size: meta.size,
					etag: meta.etag,
					contentType: meta.contentType,
					owner: meta.owner,
					updatedAt: now,
				},
			});
		return this.statsAndReport();
	}

	/** Records a completed R2 delete (also the phantom-row prune: recording a
	 * delete for a key that was never indexed is a no-op). */
	async recordDelete(identity: BucketIdentity, key: string): Promise<BucketStats> {
		await this.ensureMigrated();
		await this.ensureIdentity(identity);
		await this.db.delete(objects).where(eq(objects.key, key));
		return this.statsAndReport();
	}

	/** One indexed row, or null. The worker uses this for response metadata
	 * (content type on serve) and owner checks that want no R2 head. */
	async getObject(key: string): Promise<ObjectSummary | null> {
		await this.ensureMigrated();
		const [row] = await this.db.select().from(objects).where(eq(objects.key, key)).limit(1);
		return row ? toSummary(row) : null;
	}

	/**
	 * Keyset-paged listing in key order - no offsets: rows land mid-scan, and
	 * an offset would skip or repeat them. The cursor is the last key of the
	 * previous page.
	 */
	async listObjects(input: ListObjectsInput): Promise<ListObjectsResult> {
		await this.ensureMigrated();
		const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);

		const prefix = input.prefix ?? '';
		const filters = [];
		if (prefix) {
			filters.push(sql`${objects.key} LIKE ${prefixPattern(prefix)} ESCAPE '\\'`);
		}
		if (input.owner !== undefined) filters.push(eq(objects.owner, input.owner));

		// A delimited listing shows only DIRECT children; everything deeper is
		// represented by its folder. `instr` is 1-based and returns 0 for "not
		// found", so "no separator in the remainder after the prefix" is
		// exactly `= 0`. The prefix length is measured in the same units SQLite
		// counts (characters), so `length()` and `substr()` agree even when a
		// key holds astral characters.
		const remainder = sql`substr(${objects.key}, length(${prefix}) + 1)`;
		if (input.delimiter) {
			filters.push(sql`instr(${remainder}, '/') = 0`);
		}
		const scope = filters.length ? and(...filters) : undefined;

		const pageFilters = input.cursor ? and(scope, gt(objects.key, input.cursor)) : scope;
		const rows = await this.db
			.select()
			.from(objects)
			.where(pageFilters)
			.orderBy(asc(objects.key))
			.limit(limit + 1);
		const page = rows.slice(0, limit);
		const next = rows.length > limit ? page[page.length - 1] : null;

		const [total] = await this.db.select({ value: count() }).from(objects).where(scope);
		const result: ListObjectsResult = {
			objects: page.map(toSummary),
			total: total?.value ?? 0,
			cursor: next ? next.key : null,
		};
		if (!input.delimiter) return result;

		// Folders are a GROUPED scan rather than a keyset page: a bucket caps at
		// 10k objects, so one grouped pass is bounded, and folders have no
		// stable cursor of their own (they are derived, not stored).
		const folderScope = [];
		if (prefix) {
			folderScope.push(sql`${objects.key} LIKE ${prefixPattern(prefix)} ESCAPE '\\'`);
		}
		if (input.owner !== undefined) folderScope.push(eq(objects.owner, input.owner));
		folderScope.push(sql`instr(${remainder}, '/') > 0`);
		const folderExpr = sql<string>`substr(${objects.key}, 1, length(${prefix}) + instr(${remainder}, '/'))`;
		const folderRows = await this.db
			.select({ prefix: folderExpr, objectCount: count() })
			.from(objects)
			.where(and(...folderScope))
			.groupBy(folderExpr)
			.orderBy(asc(folderExpr))
			.limit(limit + 1);

		result.folders = folderRows.slice(0, limit).map((row) => ({
			prefix: row.prefix,
			objectCount: row.objectCount,
		}));
		result.foldersTruncated = folderRows.length > limit;
		return result;
	}

	async getStats(): Promise<BucketStats> {
		await this.ensureMigrated();
		return this.stats();
	}

	/** Erase fan-in target: the parent already drained (or will drain) R2;
	 * this drops the index and the instance. */
	async destroy(): Promise<void> {
		await this.ctx.storage.deleteAll();
		await this.ctx.storage.deleteAlarm();
		setTimeout(() => this.ctx.abort(), 0);
	}

	private async stats(): Promise<BucketStats> {
		const [row] = await this.db
			.select({ objectCount: count(), totalBytes: sum(objects.size) })
			.from(objects);
		return {
			objectCount: row?.objectCount ?? 0,
			totalBytes: Number(row?.totalBytes ?? 0),
		};
	}

	/**
	 * Debounced absolute-counter heartbeat to the parent, so quota checks and
	 * the dashboard read fresh-enough numbers without a child hop per
	 * request. Best-effort: a missed report self-heals on the next write.
	 */
	private async statsAndReport(): Promise<BucketStats> {
		const stats = await this.stats();
		const now = Date.now();
		if (now - this.lastStatsReport >= STATS_REPORT_INTERVAL_MS) {
			this.lastStatsReport = now;
			const meta = await this.ctx.storage.get<{ projectId: string; bucket: string }>('bucket-meta');
			if (meta) {
				this.ctx.waitUntil(
					(async () => {
						try {
							const namespace = this.env.StorageAgent as unknown as DurableObjectNamespace;
							const stub = namespace.get(
								namespace.idFromName(meta.projectId),
							) as unknown as StorageAgent;
							await stub.reportBucketStats(meta.bucket, stats);
						} catch {
							// heartbeat, never a failure
						}
					})(),
				);
			}
		}
		return stats;
	}
}
