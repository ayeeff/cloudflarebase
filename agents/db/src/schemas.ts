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

export const collectionModesSchema = z.strictObject({
	readAccess: accessModeSchema.default('auth'),
	writeAccess: accessModeSchema.default('auth'),
});

/** Pushed parent -> child on create/config change; cached in collection_meta. */
export const collectionConfigSchema = z.strictObject({
	projectId: projectIdSchema,
	collection: collectionNameSchema,
	readAccess: accessModeSchema,
	writeAccess: accessModeSchema,
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
