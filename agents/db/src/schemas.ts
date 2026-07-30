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
