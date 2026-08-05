import { logEntrySchema, MAX_LOG_ROWS, REPLICATION_PULL_CHUNK, type LogEntry } from './schemas';

/**
 * The replication substrate's shared plumbing (docs/db-replication-design.md):
 * role parsing from instance names, change-log append/read/prune on the
 * primary, and applied-position bookkeeping helpers for replicas. The feed
 * itself (bootstrap/pullSince RPCs) lives on the shard classes; everything
 * here is deliberately small and transport-shaped so a native platform
 * replication feature could replace the transport without touching callers.
 *
 * Raw `ctx.storage.sql` throughout rather than drizzle: log writes must land
 * in the SAME event-loop task as the data mutation they describe (DO write
 * coalescing is what makes data+log atomic - no await may separate them),
 * and the apply path runs against dynamic physical tables drizzle cannot
 * model anyway.
 */

export interface PrimaryRole {
	kind: 'primary';
}

export interface ReplicaRole {
	kind: 'replica';
	region: string;
	n: number;
	/** The primary's instance name: this one minus the `:r:` suffix. */
	primaryName: string;
	/** The registered id: `r:<region>:<n>`. */
	replicaId: string;
}

export type ShardRole = PrimaryRole | ReplicaRole;

const REPLICA_SUFFIX = /^(.+):r:([a-z-]+):(\d+)$/;

/**
 * Role from the Durable Object instance name. Project and shard names cannot
 * contain `:`, so the `:r:` suffix is unambiguous; anything else (including
 * a missing name on preview stubs) is the primary role.
 */
export function parseShardRole(instanceName: string | undefined): ShardRole {
	const match = instanceName ? REPLICA_SUFFIX.exec(instanceName) : null;
	if (!match) return { kind: 'primary' };
	return {
		kind: 'replica',
		region: match[2],
		n: Number(match[3]),
		primaryName: match[1],
		replicaId: `r:${match[2]}:${match[3]}`,
	};
}

export function replicaName(primaryName: string, region: string, n: number): string {
	return `${primaryName}:r:${region}:${n}`;
}

// ---------------------------------------------------------------------------
// Primary side: the change log

/**
 * Append one entry in the SAME task as the data write it describes. Returns
 * the new LSN (the write's session bookmark). Opportunistically prunes the
 * horizon - a replica older than the horizon is FORCED to re-bootstrap by
 * pullSince, so pruning can never create a silent gap.
 */
export function appendLog(
	sql: SqlStorage,
	op: 'put' | 'del' | 'cfg',
	id: string,
	image: string | null,
): number {
	sql.exec(
		`INSERT INTO changelog (op, id, image, ts) VALUES (?, ?, ?, ?)`,
		op,
		id,
		image,
		Date.now(),
	);
	const [row] = sql.exec(`SELECT last_insert_rowid() AS lsn`).toArray() as { lsn: number }[];
	const lsn = row?.lsn ?? 0;
	// Amortized prune: one DELETE every 512 appends keeps the log bounded
	// without paying a delete per write.
	if (lsn % 512 === 0) {
		sql.exec(`DELETE FROM changelog WHERE lsn < ?`, lsn - MAX_LOG_ROWS);
	}
	return lsn;
}

/** Current log position (0 when the log is empty or replication is off). */
export function lastLsn(sql: SqlStorage): number {
	const [row] = sql.exec(`SELECT MAX(lsn) AS lsn FROM changelog`).toArray() as {
		lsn: number | null;
	}[];
	return row?.lsn ?? 0;
}

/** Oldest retained LSN, or 0 for an empty log. */
export function horizonLsn(sql: SqlStorage): number {
	const [row] = sql.exec(`SELECT MIN(lsn) AS lsn FROM changelog`).toArray() as {
		lsn: number | null;
	}[];
	return row?.lsn ?? 0;
}

/** A bounded page of entries strictly after `since`, oldest first. */
export function readLogSince(sql: SqlStorage, since: number): LogEntry[] {
	const rows = sql
		.exec(
			`SELECT lsn, op, id, image, ts FROM changelog WHERE lsn > ? ORDER BY lsn ASC LIMIT ?`,
			since,
			REPLICATION_PULL_CHUNK,
		)
		.toArray();
	return rows.map((row) => logEntrySchema.parse(row));
}

/**
 * Whether `since` is still serviceable from the log. Retained rows cover
 * [horizon, last]; a replica at `since` needs (since, last], so it must sit
 * at or past `horizon - 1`. Two forced-resync cases fall out naturally:
 *
 * - `since > last`: the primary's log is BEHIND the replica - a PITR restore
 *   rewound it (the log rewinds with the rest of storage). This is the
 *   restore detector that works even before the parent's epoch bump lands.
 * - empty log with `since > 0`: the log was truncated (disable/re-enable);
 *   continuity cannot be verified.
 */
export function canServeSince(sql: SqlStorage, since: number): boolean {
	const last = lastLsn(sql);
	if (since > last) return false;
	if (since === last) return true;
	return since >= horizonLsn(sql) - 1;
}

export function truncateLog(sql: SqlStorage): void {
	sql.exec(`DELETE FROM changelog`);
}

// ---------------------------------------------------------------------------
// Primary side: the feed server (shared verbatim by both shard classes)

export interface RepPullInput {
	since: number;
	replicaId: string;
	region: string;
}

/** Durable registration - MUST happen before any data leaves the primary
 * (bootstrap included): the erase fan-out iterates this registry. */
export function registerReplica(
	sql: SqlStorage,
	replicaId: string,
	region: string,
	appliedLsn: number,
): void {
	sql.exec(
		`INSERT INTO replicas (id, region, applied_lsn, last_seen_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET applied_lsn = excluded.applied_lsn, last_seen_at = excluded.last_seen_at`,
		replicaId,
		region,
		appliedLsn,
		Date.now(),
	);
}

/**
 * Serve one pull. The replica is registered DURABLY before any data leaves -
 * the erase fan-out iterates that registry, so a replica holding data can
 * never be unknown to its primary. DO storage writes coalesce with the read
 * in this same task, and single-threaded execution means the registration
 * commits before any other request observes the table.
 */
export function serveRepPull(
	sql: SqlStorage,
	input: RepPullInput,
	epoch: number,
): import('./schemas').RepPullResult {
	registerReplica(sql, input.replicaId, input.region, input.since);

	if (!canServeSince(sql, input.since)) return { resync: true, epoch };

	const entries = readLogSince(sql, input.since);
	const applied = entries.length ? entries[entries.length - 1].lsn : input.since;
	sql.exec(`UPDATE replicas SET applied_lsn = ? WHERE id = ?`, applied, input.replicaId);
	return { resync: false, entries, lastLsn: lastLsn(sql), epoch };
}

export interface RegisteredReplica {
	id: string;
	region: string;
	appliedLsn: number;
	lastSeenAt: number;
}

export function listReplicas(sql: SqlStorage): RegisteredReplica[] {
	return (
		sql
			.exec(`SELECT id, region, applied_lsn, last_seen_at FROM replicas ORDER BY id`)
			.toArray() as {
			id: string;
			region: string;
			applied_lsn: number;
			last_seen_at: number;
		}[]
	).map((row) => ({
		id: row.id,
		region: row.region,
		appliedLsn: row.applied_lsn,
		lastSeenAt: row.last_seen_at,
	}));
}

export function clearReplicas(sql: SqlStorage): void {
	sql.exec(`DELETE FROM replicas`);
}

// ---------------------------------------------------------------------------
// Replica side: applied-position bookkeeping

export interface ReplicaMeta {
	epoch: number;
	appliedLsn: number;
	pulledAt: number;
}

export function readReplicaMeta(sql: SqlStorage): ReplicaMeta | null {
	const [row] = sql
		.exec(`SELECT epoch, applied_lsn, pulled_at FROM replica_meta WHERE id = 1`)
		.toArray() as { epoch: number; applied_lsn: number; pulled_at: number }[];
	return row ? { epoch: row.epoch, appliedLsn: row.applied_lsn, pulledAt: row.pulled_at } : null;
}

export function writeReplicaMeta(sql: SqlStorage, meta: ReplicaMeta): void {
	sql.exec(
		`INSERT INTO replica_meta (id, epoch, applied_lsn, pulled_at) VALUES (1, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET epoch = excluded.epoch, applied_lsn = excluded.applied_lsn, pulled_at = excluded.pulled_at`,
		meta.epoch,
		meta.appliedLsn,
		meta.pulledAt,
	);
}
