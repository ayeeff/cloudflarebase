import { z } from 'zod';

/**
 * Every boundary schema for the db agent: the query DSL, document CRUD
 * bodies, the live-query WebSocket frames, collection configuration, and the
 * untrusted third-party shapes (JWKS). Conventions mirror the auth agent:
 * strictObject for request bodies, `.catch` for env/storage reads, and a
 * schema - never a cast - for anything that crosses a trust boundary.
 *
 * The app's `src/lib/agents.ts` carries hand-copied mirrors of the DTO
 * schemas with `.meta({ id })` so they double as OpenAPI components. Keep the
 * copies in sync. The client SDK imports THESE schemas directly (same
 * package), so client and server cannot drift.
 */

export const projectIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);

/** Collection names become Durable Object name suffixes - keep them tame. */
export const collectionNameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

export const DEMO_PROJECT_PATTERN = /^demo-[a-f0-9]{20}$/;

/** Bad env degrades to 24h instead of throwing in onStart. */
export const demoTtlHoursSchema = z.coerce.number().int().min(1).max(720).catch(24);

// ---------------------------------------------------------------------------
// Query DSL

/** Dotted JSON path, each segment an identifier; regex-validated so SQL
 * interpolation of `'$.a.b'` is injection-free. */
export const fieldPathSchema = z
	.string()
	.max(128)
	.regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,3}$/);

const scalarSchema = z.union([z.string().max(1024), z.number().finite(), z.boolean(), z.null()]);

export const whereClauseSchema = z
	.strictObject({
		field: fieldPathSchema,
		op: z.enum(['==', '!=', '<', '<=', '>', '>=', 'in', 'array-contains']),
		value: z.union([scalarSchema, z.array(scalarSchema).min(1).max(20)]),
	})
	.refine((clause) => (clause.op === 'in') === Array.isArray(clause.value), {
		message: "'in' takes an array of values; every other operator takes a scalar",
	})
	.refine((clause) => clause.op === '==' || clause.op === '!=' || !isNullish(clause.value), {
		message: 'null can only be compared with == or !=',
	});

function isNullish(value: unknown): boolean {
	return value === null || (Array.isArray(value) && value.some((entry) => entry === null));
}

export const orderBySchema = z.strictObject({
	field: fieldPathSchema,
	direction: z.enum(['asc', 'desc']),
});

export const MAX_QUERY_LIMIT = 200;

export const querySchema = z.strictObject({
	where: z.array(whereClauseSchema).max(10).optional(),
	orderBy: z.array(orderBySchema).max(2).optional(),
	limit: z.number().int().min(1).max(MAX_QUERY_LIMIT).optional(),
	/** Opaque continuation from a previous page. REST only - never subscriptions. */
	cursor: z.string().max(2048).optional(),
});

export type Query = z.infer<typeof querySchema>;
export type WhereClause = z.infer<typeof whereClauseSchema>;

// ---------------------------------------------------------------------------
// Aggregations (REST only)

const aggregateAliasSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,31}$/);

export const aggregateSpecSchema = z
	.strictObject({
		op: z.enum(['count', 'sum', 'avg']),
		field: fieldPathSchema.optional(),
	})
	.refine((spec) => (spec.op === 'count' ? spec.field === undefined : spec.field !== undefined), {
		message: "'count' takes no field; 'sum' and 'avg' require one",
	});

/** Firestore's aggregate set: count/sum/avg over the same where clauses as a
 * query. sum and avg consider only numeric field values (booleans and strings
 * are skipped, matching Firestore); sum of nothing is 0, avg of nothing null. */
export const aggregateRequestSchema = z
	.strictObject({
		where: z.array(whereClauseSchema).max(10).optional(),
		aggregates: z.record(aggregateAliasSchema, aggregateSpecSchema),
	})
	.refine(
		(request) => {
			const count = Object.keys(request.aggregates).length;
			return count >= 1 && count <= 5;
		},
		{ message: 'between 1 and 5 aggregates per request' },
	);

export type AggregateRequest = z.infer<typeof aggregateRequestSchema>;

export interface AggregateResult {
	results: Record<string, number | null>;
}

// ---------------------------------------------------------------------------
// Rules-lite: permission gates and document validators

/** The auth agent's permission-key grammar verbatim: `resource:action`
 * segments or `*`. Requiring `*` effectively means "admin tokens only". */
export const permissionKeySchema = z
	.string()
	.trim()
	.max(64)
	.regex(/^(\*|[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)*)$/);

/** Validators address top-level fields only - dotted paths would make PATCH
 * merge semantics ambiguous. */
const ruleFieldNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);

export const fieldRuleSchema = z.strictObject({
	type: z.enum(['string', 'number', 'boolean', 'object', 'array', 'null', 'any']).default('any'),
	required: z.boolean().default(false),
	/** Strings and arrays: maximum length. */
	maxLength: z.number().int().min(0).max(131072).optional(),
	/** Numbers only. */
	min: z.number().optional(),
	max: z.number().optional(),
	enum: z.array(scalarSchema).min(1).max(20).optional(),
});

export const validatorSchema = z
	.strictObject({
		fields: z.record(ruleFieldNameSchema, fieldRuleSchema),
		additionalFields: z.enum(['allow', 'reject']).default('allow'),
	})
	.refine(
		(validator) => {
			const count = Object.keys(validator.fields).length;
			return count >= 1 && count <= 20;
		},
		{ message: 'a validator declares 1 to 20 top-level fields' },
	);

export type FieldRule = z.infer<typeof fieldRuleSchema>;
export type CollectionValidator = z.infer<typeof validatorSchema>;

// ---------------------------------------------------------------------------
// Documents

export const documentIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** JSON-serialized `data` ceiling; demo projects use the smaller cap. */
export const MAX_DOC_BYTES = 128 * 1024;

export const documentDataSchema = z.record(z.string().max(256), z.unknown());

export const createDocumentSchema = z.strictObject({
	id: documentIdSchema.optional(),
	data: documentDataSchema,
});

export const writeDocumentSchema = z.strictObject({
	data: documentDataSchema,
});

/** The wire shape of a document: metadata outside `data`, no collisions. */
export interface DbDocument {
	id: string;
	data: Record<string, unknown>;
	owner: string | null;
	createdAt: string;
	updatedAt: string;
}

// ---------------------------------------------------------------------------
// Replication (phase REP1 of docs/db-scale-plan.md; docs/db-replication-design.md)

export const replicationModeSchema = z.enum(['off', 'auto']);
export type ReplicationMode = z.infer<typeof replicationModeSchema>;

/** Session bookmark headers - the D1 Sessions contract, LSN-shaped. Writes
 * on a replicated primary answer with LSN_HEADER; clients echo the highest
 * seen value on reads via MIN_LSN_HEADER for read-your-writes on replicas. */
export const LSN_HEADER = 'cfb-lsn';
export const MIN_LSN_HEADER = 'cfb-min-lsn';

/** One change-log row (row images, never statements - deterministic apply,
 * engine-agnostic: the same substrate replicates documents and typed rows). */
export const logEntrySchema = z.object({
	lsn: z.number().int().min(1),
	op: z.enum(['put', 'del', 'cfg']),
	id: z.string(),
	/** DTO JSON for put, config JSON for cfg, null tombstone for del. */
	image: z.string().nullable(),
	ts: z.number(),
});
export type LogEntry = z.infer<typeof logEntrySchema>;

export const REPLICATION_PULL_CHUNK = 500;
/** Log retention; a replica behind the horizon is FORCED to re-bootstrap. */
export const MAX_LOG_ROWS = 100_000;
/** REP1 freshness window: replica reads may lag this far unless the session
 * bookmark demands newer. Matches the dashboard's own polling cadence. */
export const MAX_REPLICA_LAG_MS = 3_000;

export type RepPullResult =
	| { resync: true; epoch: number }
	| { resync: false; entries: LogEntry[]; lastLsn: number; epoch: number };

export const repPullInputSchema = z.strictObject({
	since: z.number().int().min(0),
	replicaId: z.string().regex(/^r:[a-z-]+:\d+$/),
	region: z.string().min(1).max(16),
});

/** Primary -> replica push (REP2): entries applied live, or a healing hint. */
export const repApplyInputSchema = z.strictObject({
	entries: z.array(logEntrySchema).min(1).max(REPLICATION_PULL_CHUNK),
	epoch: z.number().int().min(0),
});
export type RepApplyResult =
	/** Applied (or already had them) - keep pushing. */
	| { ok: true }
	/** Out of order / wrong epoch; the replica pulled to heal. */
	| { healed: true }
	/** No subscribers left here - stop pushing until they return. */
	| { stop: true };

export const repSetPushInputSchema = z.strictObject({
	replicaId: z.string().regex(/^r:[a-z-]+:\d+$/),
	region: z.string().min(1).max(16),
	push: z.boolean(),
});

/** Observability payloads (`/admin/replication/:name`, the replica map). */
export interface RepReplicaStatus {
	id: string;
	region: string;
	appliedLsn: number;
	lagLsn: number;
	/** Receiving live pushes (it holds subscribers). */
	push: boolean;
	lastSeenAt: string;
}
export interface RepStatus {
	enabled: boolean;
	epoch: number;
	lastLsn: number;
	horizonLsn: number;
	replicas: RepReplicaStatus[];
}

// ---------------------------------------------------------------------------
// Collection configuration

export const accessModeSchema = z.enum(['public', 'auth', 'owner']);
export type AccessMode = z.infer<typeof accessModeSchema>;

/**
 * The PUT /admin/collections/:name body. Permission gates and the validator
 * are three-state: omitted = leave unchanged (so a modes-only save can never
 * clobber rules configured earlier), explicit null = clear.
 */
export const collectionModesSchema = z.strictObject({
	readAccess: accessModeSchema.default('auth'),
	writeAccess: accessModeSchema.default('auth'),
	readPermission: permissionKeySchema.nullable().optional(),
	writePermission: permissionKeySchema.nullable().optional(),
	validator: validatorSchema.nullable().optional(),
	/** Three-state like the permission fields: omitted = unchanged. */
	replication: replicationModeSchema.optional(),
});

/** Pushed parent -> child on create/config change; cached in collection_meta. */
export const collectionConfigSchema = z.strictObject({
	projectId: projectIdSchema,
	collection: collectionNameSchema,
	readAccess: accessModeSchema,
	writeAccess: accessModeSchema,
	/** Permission the JWT's `permissions` claim must carry (`*` always passes).
	 * Only meaningful for auth/owner modes - public requests carry no token. */
	readPermission: z.string().nullable(),
	writePermission: z.string().nullable(),
	/** Document rules for the public write path; operator surfaces bypass. */
	validator: validatorSchema.nullable(),
	allowedOrigins: z.array(z.string()).max(10),
	demo: z.boolean(),
	/** Monotonic; lets a child ignore a stale push after a failed retry. */
	configVersion: z.number().int().min(0),
	/** Defaults keep configs stored before REP1 parseable. */
	replication: replicationModeSchema.default('off'),
	/** PARENT-owned restore epoch: bumped after a PITR restore so replicas
	 * discard and re-bootstrap. Lives in config (not the primary's storage)
	 * because a restore rewinds the primary's storage - including any epoch
	 * it would have kept itself. */
	repEpoch: z.number().int().min(0).default(0),
});
export type CollectionConfig = z.infer<typeof collectionConfigSchema>;

/** Parses untrusted DO storage in onStart-equivalents. */
export const storedConfigSchema = collectionConfigSchema.nullable().catch(null);

export const settingsRequestSchema = z.strictObject({
	allowedOrigins: z
		.array(
			z
				.string()
				.trim()
				.max(256)
				.transform((value, ctx) => {
					let parsed: URL;
					try {
						parsed = new URL(value);
					} catch {
						ctx.addIssue({ code: 'custom', message: `"${value}" is not a valid origin` });
						return z.NEVER;
					}
					const localhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
					if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && localhost)) {
						ctx.addIssue({ code: 'custom', message: `"${value}" must be https` });
						return z.NEVER;
					}
					if (parsed.origin !== value) {
						ctx.addIssue({ code: 'custom', message: `"${value}" must be a bare origin` });
						return z.NEVER;
					}
					return parsed.origin;
				}),
		)
		.max(10)
		.transform((origins) => [...new Set(origins)]),
});

// ---------------------------------------------------------------------------
// Tables: the typed-column DSL (phase T1 of docs/db-scale-plan.md)

/** Table names are DO name suffixes exactly like collection names; the
 * physical SQLite table inside the instance is always `rows`. */
export const tableNameSchema = collectionNameSchema;

/**
 * No leading underscore (reserved for future system use) and no hyphens
 * (column names appear as dotted query field-path segments). Quoted in all
 * generated SQL regardless. The system columns are PLAIN reserved names -
 * `id`, `owner`, `created_at`, `updated_at` - so ORM-generated SQL reads
 * like a normal table; the reservation lives in tableColumnsSchema.
 */
export const columnNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

/** Owned by the platform: the row envelope's fields as real SQL columns. */
export const RESERVED_COLUMN_NAMES = ['id', 'owner', 'created_at', 'updated_at'] as const;

export const columnTypeSchema = z.enum(['text', 'integer', 'real', 'boolean', 'json']);
export type ColumnType = z.infer<typeof columnTypeSchema>;

export const MAX_TABLE_COLUMNS = 64;
/** unique + index combined. */
export const MAX_TABLE_INDEXES = 16;

/**
 * One declared column. SQLite affinity is NOT the type system - it would
 * happily store text in an INTEGER column - so the write path validates
 * values against `type` in JS before binding. The rules-lite bounds
 * (maxLength/min/max/enum) are enforced in the same place, never as CHECK
 * constraints (CHECK cannot be added or altered after the fact).
 */
export const tableColumnSchema = z
	.strictObject({
		name: columnNameSchema,
		type: columnTypeSchema,
		nullable: z.boolean().default(true),
		/** Materialized by the WRITE PATH (missing column -> default), so
		 * changing it later is metadata-only. The SQL DEFAULT clause is only
		 * emitted where SQLite demands one: ADD COLUMN ... NOT NULL. */
		default: scalarSchema.optional(),
		/** Implemented as a UNIQUE index; implies `index`. */
		unique: z.boolean().default(false),
		index: z.boolean().default(false),
		/** text columns: maximum string length. */
		maxLength: z.number().int().min(0).max(131072).optional(),
		/** integer/real columns only. */
		min: z.number().optional(),
		max: z.number().optional(),
		/** text/integer/real columns: allowed values. */
		enum: z.array(scalarSchema).min(1).max(20).optional(),
	})
	.superRefine((column, ctx) => {
		const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
		if (column.default !== undefined && !valueFitsType(column.type, column.default)) {
			fail(`"${column.name}": default must be a ${column.type}`);
		}
		if (column.type === 'json' && column.default !== undefined) {
			fail(`"${column.name}": json columns cannot declare a default`);
		}
		// NOT NULL without a default is legal and useful - it means "required on
		// write". Only ADDING such a column to an existing table is refused (the
		// DDL planner owns that rule: SQLite must backfill existing rows).
		if (column.maxLength !== undefined && column.type !== 'text') {
			fail(`"${column.name}": maxLength applies to text columns`);
		}
		if (
			(column.min !== undefined || column.max !== undefined) &&
			column.type !== 'integer' &&
			column.type !== 'real'
		) {
			fail(`"${column.name}": min/max apply to integer and real columns`);
		}
		if (column.enum !== undefined && (column.type === 'json' || column.type === 'boolean')) {
			fail(`"${column.name}": enum applies to text, integer, and real columns`);
		}
	});
export type TableColumn = z.infer<typeof tableColumnSchema>;

/** Scalar-vs-declared-type check shared by the schema and the write path. */
export function valueFitsType(type: ColumnType, value: string | number | boolean | null): boolean {
	if (value === null) return true;
	switch (type) {
		case 'text':
			return typeof value === 'string';
		case 'integer':
			return typeof value === 'number' && Number.isInteger(value);
		case 'real':
			return typeof value === 'number';
		case 'boolean':
			return typeof value === 'boolean';
		case 'json':
			return true;
	}
}

export const tableColumnsSchema = z
	.array(tableColumnSchema)
	.min(1)
	.max(MAX_TABLE_COLUMNS)
	.superRefine((columns, ctx) => {
		const names = new Set<string>();
		for (const column of columns) {
			if (names.has(column.name)) {
				ctx.addIssue({ code: 'custom', message: `duplicate column "${column.name}"` });
			}
			names.add(column.name);
			if ((RESERVED_COLUMN_NAMES as readonly string[]).includes(column.name)) {
				ctx.addIssue({
					code: 'custom',
					message: `"${column.name}" is a system column (id, owner, created_at, updated_at are reserved)`,
				});
			}
		}
		const indexes = columns.filter((column) => column.unique || column.index).length;
		if (indexes > MAX_TABLE_INDEXES) {
			ctx.addIssue({
				code: 'custom',
				message: `a table is limited to ${MAX_TABLE_INDEXES} indexed columns`,
			});
		}
	});

/**
 * The PUT /admin/tables/:name body. Permissions are three-state exactly like
 * collections (omitted = unchanged, null = clear); `columns` is the full
 * desired schema - the parent diffs it against the registry's stored columns
 * and refuses destructive changes before anything is pushed.
 */
export const tableModesSchema = z.strictObject({
	readAccess: accessModeSchema.default('auth'),
	writeAccess: accessModeSchema.default('auth'),
	readPermission: permissionKeySchema.nullable().optional(),
	writePermission: permissionKeySchema.nullable().optional(),
	columns: tableColumnsSchema,
	/** Three-state like the permission fields: omitted = unchanged. */
	replication: replicationModeSchema.optional(),
});

/** Pushed parent -> child; cached in collection_meta alongside a record of
 * what DDL has actually been applied (pragma_table_info is SQLITE_AUTH). */
export const tableConfigSchema = z.strictObject({
	kind: z.literal('table'),
	projectId: projectIdSchema,
	table: tableNameSchema,
	readAccess: accessModeSchema,
	writeAccess: accessModeSchema,
	readPermission: z.string().nullable(),
	writePermission: z.string().nullable(),
	columns: tableColumnsSchema,
	allowedOrigins: z.array(z.string()).max(10),
	demo: z.boolean(),
	configVersion: z.number().int().min(0),
	replication: replicationModeSchema.default('off'),
	repEpoch: z.number().int().min(0).default(0),
});
export type TableConfig = z.infer<typeof tableConfigSchema>;

export const storedTableConfigSchema = tableConfigSchema.nullable().catch(null);

/**
 * The child's cached meta row: the pushed config plus the record of what DDL
 * has actually been applied - which replaces introspection, because
 * `pragma_table_info()` is SQLITE_AUTH. `appliedColumns` only moves after
 * every planned statement succeeded.
 */
export const storedTableMetaSchema = z
	.object({ config: tableConfigSchema, appliedColumns: tableColumnsSchema })
	.nullable()
	.catch(null);
export type TableMeta = { config: TableConfig; appliedColumns: TableColumn[] };

/**
 * A row's wire shape is deliberately the document envelope - `data` is the
 * column-value map (json columns parsed, booleans as true/false) - so the
 * live-query frames, the SDK subscribe machinery, and the dashboard change
 * handling are shared with collections rather than forked.
 */
export type DbRow = DbDocument;

// --- The D1-shaped SQL endpoint (T2; db-table-design.md §10) ---

const sqlStatementSchema = z.strictObject({
	sql: z.string().min(1).max(10_000),
	params: z
		.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
		.max(100)
		.optional(),
});

/** One statement, or an atomic batch (transactionSync under the hood). */
export const tableSqlRequestSchema = z.union([
	sqlStatementSchema,
	z.strictObject({ batch: z.array(sqlStatementSchema).min(1).max(20) }),
]);

/** D1-shaped per-statement result. `raw` + `columns` exist for ORM drivers
 * (drizzle's sqlite-proxy wants value arrays in column order). */
export interface TableSqlResult {
	results: Record<string, unknown>[];
	columns: string[];
	raw: unknown[][];
	meta: { changes: number; rows_read: number; rows_written: number };
}

export type TableSqlResponse =
	| { success: true; result: TableSqlResult }
	| { success: true; batch: TableSqlResult[] }
	| { success: false; error: string };

// ---------------------------------------------------------------------------
// Export / import / point-in-time restore

export const MAX_IMPORT_DOCS = 1000;
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
/** Lines per parent->child RPC call, well under the RPC payload ceiling. */
export const IMPORT_RPC_CHUNK = 100;
export const EXPORT_CHUNK = 500;

/**
 * One NDJSON import line. An exported document round-trips exactly (id,
 * owner, and timestamps are preserved - import is operator-only, so the
 * caller is trusted with them); a bare `{ data }` line mints a fresh id.
 * Unknown keys are stripped rather than refused.
 */
export const importLineSchema = z.object({
	id: documentIdSchema.optional(),
	data: documentDataSchema,
	owner: z.string().max(256).nullable().optional(),
	createdAt: z.iso.datetime().optional(),
	updatedAt: z.iso.datetime().optional(),
});
export type ImportLine = z.infer<typeof importLineSchema>;

export interface ImportReport {
	imported: number;
	updated: number;
	errors: { line: number; error: string }[];
}

/**
 * Named PITR bookmarks the parent persists per collection and the dashboard
 * lists, D1-Time-Travel-style. These are MARKERS, not the recovery window:
 * restore-by-timestamp reaches any moment in the platform's 30 days
 * regardless. The cap only stops a scripted importer from growing the marker
 * list without bound; 30-day pruning is the real limit.
 */
export const MAX_RESTORE_POINTS = 200;

export const checkpointRequestSchema = z.strictObject({
	reason: z.string().trim().min(1).max(80).optional(),
});

export interface RestorePoint {
	bookmark: string;
	reason: string;
	capturedAt: string;
}

/** Restore to a wall-clock time (30-day window) or to an exact bookmark - the
 * undo path: every successful restore returns the bookmark that reverses it. */
export const restoreRequestSchema = z
	.strictObject({
		timestamp: z.iso.datetime().optional(),
		bookmark: z.string().min(1).max(256).optional(),
	})
	.refine((request) => (request.timestamp === undefined) !== (request.bookmark === undefined), {
		message: 'exactly one of timestamp or bookmark is required',
	});

export type RestoreRequest = z.infer<typeof restoreRequestSchema>;

export type RestoreOutcome =
	| { ok: true; undoBookmark: string }
	| { ok: false; code: 'unsupported' | 'failed'; message?: string };

/** Timestamp -> closest-available-bookmark resolution (D1-restore-style). */
export type BookmarkOutcome =
	{ ok: true; bookmark: string } | { ok: false; code: 'unsupported' | 'failed'; message?: string };

// ---------------------------------------------------------------------------
// Live-query protocol frames (shared verbatim with the client SDK)

export const subscribeFrameSchema = z.strictObject({
	type: z.literal('subscribe'),
	id: z.string().min(1).max(64),
	query: querySchema.omit({ cursor: true }),
	token: z.string().max(8192).optional(),
});

export const unsubscribeFrameSchema = z.strictObject({
	type: z.literal('unsubscribe'),
	id: z.string().min(1).max(64),
});

export const clientFrameSchema = z.union([subscribeFrameSchema, unsubscribeFrameSchema]);
export type ClientFrame = z.infer<typeof clientFrameSchema>;

const dbDocumentSchema = z.object({
	id: z.string(),
	data: z.record(z.string(), z.unknown()),
	owner: z.string().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export const serverFrameSchema = z.union([
	z.strictObject({
		type: z.literal('snapshot'),
		id: z.string(),
		docs: z.array(dbDocumentSchema),
	}),
	z.strictObject({
		type: z.literal('change'),
		id: z.string(),
		kind: z.enum(['added', 'modified', 'removed']),
		doc: dbDocumentSchema,
	}),
	z.strictObject({ type: z.literal('unsubscribed'), id: z.string() }),
	z.strictObject({
		type: z.literal('error'),
		id: z.string().optional(),
		code: z.enum([
			'invalid-frame',
			'invalid-query',
			'unauthorized',
			'token-expired',
			'subscription-limit',
			'internal',
		]),
		message: z.string(),
	}),
]);
export type ServerFrame = z.infer<typeof serverFrameSchema>;

// ---------------------------------------------------------------------------
// Third-party responses

/** The auth agent's JWKS endpoint - untrusted input across a binding. */
export const jwksResponseSchema = z.object({
	keys: z.array(z.record(z.string(), z.unknown())).max(10),
});

/** JWT payload after signature verification - claims we rely on. */
export const jwtClaimsSchema = z.object({
	sub: z.string().min(1),
	email: z.string().optional(),
	role: z.string().optional(),
	permissions: z.array(z.string()).optional(),
});
export type JwtClaims = z.infer<typeof jwtClaimsSchema>;
