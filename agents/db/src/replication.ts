import {
	logEntrySchema,
	MAX_LOG_ROWS,
	REPLICATION_PULL_CHUNK,
	type LogEntry,
} from './schemas';

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
