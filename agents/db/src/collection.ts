import { DurableObject } from 'cloudflare:workers';
import { and, count, eq } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { z } from 'zod';
import migrations from './migrations';
import * as schema from './db/schema';
import { collectionMeta, documents, subscriptions } from './db/schema';
import { ProjectJwtVerifier } from './jwt';
import {
	compileAggregate,
	compileQuery,
	decodeCursor,
	encodeCursor,
	isWindowed,
	matchesQuery,
	type DecodedCursor,
} from './query';
import { hasPermission, validateDocument } from './rules';
import {
	aggregateRequestSchema,
	clientFrameSchema,
	collectionConfigSchema,
	createDocumentSchema,
	documentDataSchema,
	importLineSchema,
	querySchema,
	restoreRequestSchema,
	storedConfigSchema,
	subscribeFrameSchema,
	EXPORT_CHUNK,
	IMPORT_RPC_CHUNK,
	MAX_DOC_BYTES,
	type AccessMode,
	type AggregateRequest,
	type AggregateResult,
	type BookmarkOutcome,
	type CollectionConfig,
	type DbDocument,
	type ImportReport,
	type Query,
	type RestoreOutcome,
	type ServerFrame,
} from './schemas';
import type { DbAgent } from './agent';

/**
 * One collection's documents, query engine, and live-query subscriptions.
 *
 * Deliberately a plain DurableObject, not an Agents SDK Agent: the public
 * subscriber socket must never receive SDK protocol frames (state sync would
 * broadcast operator data to anonymous clients), and the raw WebSocket
 * Hibernation API gives exact control over subscription survival. The
 * attachment carries only `{ connId }`; the `subscriptions` table is the
 * durable source of truth, so a hibernated instance woken by a frame
 * restores full context from SQLite with zero in-memory state.
 *
 * Instance name: `<projectId>:<collectionName>` - the first `:` is an
 * unambiguous separator because neither id allows one. The hot data path
 * (worker -> this DO) is a single hop; config is cached locally and pushed
 * by the parent, so serving a request never consults the parent. The one
 * exception is first touch: an instance with no cached config pulls it once
 * via `DbAgent.getCollectionConfig({ autoCreate: true })`, which is also
 * what heals a parent-side row whose config push failed.
 */

export const MAX_SUBSCRIPTIONS_PER_CONNECTION = 10;
/** Local dev keeps no durable change log; workerd phrases it several ways. */
const UNSUPPORTED_PITR_PATTERN = /does not implement|not (yet )?(supported|implemented|available)/i;
const DEMO_MAX_SUBSCRIPTIONS_PER_CONNECTION = 5;
const DEMO_MAX_DOCS_PER_COLLECTION = 200;
const DEMO_MAX_DOC_BYTES = 8 * 1024;
/**
 * Debounce for absolute-count reports to the parent. This is the dashboard's
 * freshness ceiling (write -> child report -> parent rev bump -> console
 * refetch), kept short enough to feel live while still coalescing write
 * bursts into one RPC. The PRODUCT live-query socket pushes deltas
 * immediately and never waits on this.
 */
const STATS_REPORT_MS = 500;

type DocumentRow = typeof documents.$inferSelect;

export class DbCollection extends DurableObject<Env> {
	private db: DrizzleSqliteDODatabase<typeof schema>;
	private config: CollectionConfig | null = null;
	private verifier: ProjectJwtVerifier | null = null;
	private statsTimer: ReturnType<typeof setTimeout> | null = null;
	private localAnalyticsReady = false;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = drizzle(ctx.storage, { schema });
		// Idempotent - drizzle tracks applied migrations in its own table.
		// Tables the parent class owns simply stay empty here.
		ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);
			this.config = storedConfigSchema.parse(await this.loadStoredConfig());
		});
	}

	private async loadStoredConfig(): Promise<unknown> {
		const [row] = await this.db.select().from(collectionMeta).limit(1);
		if (!row) return null;
		try {
			return JSON.parse(row.config);
		} catch {
			return null;
		}
	}

	// -------------------------------------------------------------------------
	// RPC surface (parent and worker entrypoint only - never public HTTP)

	/** Parent push on create/config change. Stale versions are ignored. */
	async configure(input: unknown): Promise<void> {
		const parsed = collectionConfigSchema.parse(input);
		if (this.config && parsed.configVersion < this.config.configVersion) return;
		this.config = parsed;
		this.verifier = null;
		await this.db
			.insert(collectionMeta)
			.values({ id: 1, config: JSON.stringify(parsed), updatedAt: new Date() })
			.onConflictDoUpdate({
				target: collectionMeta.id,
				set: { config: JSON.stringify(parsed), updatedAt: new Date() },
			});
	}

	/** Operator query over the dashboard proxy (parent-forwarded). */
	async adminQuery(input: unknown): Promise<{ docs: DbDocument[]; nextCursor?: string }> {
		const query = querySchema.parse(input);
		return this.runQuery(query, null);
	}

	/** Operator aggregate (parent-forwarded); bypasses access modes. */
	async adminAggregate(input: unknown): Promise<AggregateResult> {
		return this.runAggregate(aggregateRequestSchema.parse(input), null);
	}

	/** Operator export chunk (parent-forwarded; no owner scoping). The
	 * parameter is an optional string rather than `string | null` because a
	 * null union breaks the workers-types RPC transform (the stub method
	 * collapses to `never`). */
	async exportChunk(afterId?: string): Promise<{ docs: DbDocument[]; nextAfterId: string | null }> {
		const docs = this.exportRows(afterId ?? null, EXPORT_CHUNK, null);
		return { docs, nextAfterId: docs.length < EXPORT_CHUNK ? null : docs[docs.length - 1].id };
	}

	/**
	 * Operator import chunk (parent-forwarded). Upserts by id, preserving
	 * owner and timestamps when the line carries them, so round-tripping an
	 * export restores what was there. Validator rules do NOT apply - this is
	 * an operator surface, like the dashboard editor - but size and demo caps
	 * do. Per-line failures are reported rather than fatal: a 900-line dump
	 * should not be all-or-nothing across RPC chunks that cannot share a
	 * transaction anyway.
	 */
	async importDocs(input: unknown): Promise<ImportReport> {
		const lines = z.array(importLineSchema).max(IMPORT_RPC_CHUNK).parse(input);
		const report: ImportReport = { imported: 0, updated: 0, errors: [] };

		for (const [index, line] of lines.entries()) {
			try {
				const sizeIssue = this.docSizeIssue(line.data);
				if (sizeIssue) {
					report.errors.push({ line: index, error: sizeIssue });
					continue;
				}
				const id = line.id ?? crypto.randomUUID();
				const [existing] = await this.db
					.select()
					.from(documents)
					.where(eq(documents.id, id))
					.limit(1);
				if (
					!existing &&
					this.config?.demo &&
					(await this.getDocCount()) >= DEMO_MAX_DOCS_PER_COLLECTION
				) {
					report.errors.push({
						line: index,
						error: `demo collections are capped at ${DEMO_MAX_DOCS_PER_COLLECTION} documents`,
					});
					continue;
				}
				await this.writeDocument(id, line.data, {
					mode: 'replace',
					owner: line.owner ?? null,
					upsert: true,
					createdAt: line.createdAt ? new Date(line.createdAt) : undefined,
					updatedAt: line.updatedAt ? new Date(line.updatedAt) : undefined,
					replaceOwner: line.owner !== undefined,
				});
				if (existing) report.updated += 1;
				else report.imported += 1;
			} catch (error) {
				report.errors.push({
					line: index,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return report;
	}

	/**
	 * Point-in-time restore over the platform's SQLite bookmarks. The restore
	 * takes effect at the START of the next session, so this closes every
	 * subscriber (reconnects get fresh snapshots against the restored data)
	 * and aborts a tick later; the returned undo bookmark reverses the whole
	 * thing via another restore. Local development keeps no durable change
	 * log, so the API reports unsupported there.
	 */
	async restoreTo(input: unknown): Promise<RestoreOutcome> {
		const parsed = restoreRequestSchema.parse(input);
		const storage = this.ctx.storage;
		if (
			typeof storage.getBookmarkForTime !== 'function' ||
			typeof storage.onNextSessionRestoreBookmark !== 'function'
		) {
			return { ok: false, code: 'unsupported' };
		}

		try {
			const bookmark =
				parsed.bookmark ?? (await storage.getBookmarkForTime(new Date(parsed.timestamp ?? 0)));
			const undoBookmark = await storage.onNextSessionRestoreBookmark(bookmark);
			for (const ws of this.ctx.getWebSockets()) {
				try {
					ws.close(1012, 'collection restored');
				} catch {
					// a half-dead socket must not block the restore
				}
			}
			setTimeout(() => this.ctx.abort(), 0);
			return { ok: true, undoBookmark };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// Miniflare implements the methods but rejects the calls - observed:
			// "This Durable Object's storage back-end does not implement
			// point-in-time recovery." A real platform failure (e.g. a bookmark
			// past the 30-day window) reports as failed with its message.
			return UNSUPPORTED_PITR_PATTERN.test(message)
				? { ok: false, code: 'unsupported' }
				: { ok: false, code: 'failed', message: message.slice(0, 256) };
		}
	}

	/**
	 * The bookmark for this exact moment - the parent persists these as named
	 * restore points (manual checkpoints, before imports, before rollbacks)
	 * and doubles this call as the PITR support probe. No side effects.
	 *
	 * The probe exercises getBookmarkForTime, not just getCurrentBookmark:
	 * local workerd serves the latter while refusing the rest of the PITR API,
	 * and "supported" must mean a restore would actually work. Only the
	 * back-end's "does not implement" answer counts as unsupported - a young
	 * DO can reject a specific timestamp (its change log may postdate it)
	 * while PITR itself is fully available.
	 */
	async currentBookmark(): Promise<{ ok: true; bookmark: string } | { ok: false }> {
		const storage = this.ctx.storage;
		if (
			typeof storage.getCurrentBookmark !== 'function' ||
			typeof storage.getBookmarkForTime !== 'function'
		) {
			return { ok: false };
		}
		try {
			const bookmark = await storage.getCurrentBookmark();
			try {
				await storage.getBookmarkForTime(new Date());
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (UNSUPPORTED_PITR_PATTERN.test(message)) return { ok: false };
			}
			return { ok: true, bookmark };
		} catch {
			return { ok: false };
		}
	}

	/**
	 * D1-restore-style resolution: a wall-clock time in, the closest available
	 * bookmark out - shown to the operator BEFORE anything is restored. No
	 * side effects.
	 */
	async bookmarkForTime(input: unknown): Promise<BookmarkOutcome> {
		const timestamp = z.iso.datetime().parse(input);
		const storage = this.ctx.storage;
		if (typeof storage.getBookmarkForTime !== 'function') {
			return { ok: false, code: 'unsupported' };
		}
		try {
			return { ok: true, bookmark: await storage.getBookmarkForTime(new Date(timestamp)) };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return UNSUPPORTED_PITR_PATTERN.test(message)
				? { ok: false, code: 'unsupported' }
				: { ok: false, code: 'failed', message: message.slice(0, 256) };
		}
	}

	/** Operator upsert (dashboard document editor). */
	async adminPut(id: string, data: unknown): Promise<DbDocument> {
		const parsed = documentDataSchema.parse(data);
		return this.writeDocument(id, parsed, { mode: 'replace', owner: undefined, upsert: true });
	}

	/** Operator delete. Returns false when the document does not exist. */
	async adminDelete(id: string): Promise<boolean> {
		return this.deleteDocument(id, null);
	}

	/** Exact live count, for parent-initiated reconciliation. */
	async getDocCount(): Promise<number> {
		const [row] = await this.db.select({ value: count() }).from(documents);
		return row?.value ?? 0;
	}

	/**
	 * Erase this collection. deleteAll leaves any alarm armed; this class
	 * schedules none, but deleteAlarm is kept for symmetry with the auth
	 * agent's hard-won sequence. The deferred abort preserves the RPC's own
	 * response - aborting synchronously would fail every successful erase.
	 */
	async destroy(): Promise<void> {
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.close(1001, 'collection erased');
			} catch {
				// closing a half-dead socket must not block the erase
			}
		}
		await this.ctx.storage.deleteAll();
		await this.ctx.storage.deleteAlarm();
		setTimeout(() => this.ctx.abort(), 0);
	}

	// -------------------------------------------------------------------------
	// HTTP surface: /agents/db-agent/<pid>/collections/<name>/...

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const match = url.pathname.match(/^\/agents\/[^/]+\/([^/]+)\/collections\/([^/]+)(\/.*)?$/);
		if (!match) return Response.json({ error: 'not found' }, { status: 404 });
		const subPath = match[3] ?? '/';

		const config = await this.ensureConfig(match[1], match[2]);
		if (!config) {
			return Response.json({ error: 'collection is unavailable' }, { status: 503 });
		}

		const cors = this.corsHeaders(request);
		if (request.method === 'OPTIONS') {
			return cors
				? new Response(null, { status: 204, headers: cors })
				: Response.json({ error: 'origin is not trusted' }, { status: 403 });
		}
		// A browser request from an untrusted origin gets an explicit refusal,
		// mirroring the auth agent's INVALID_ORIGIN behavior.
		if (request.headers.get('origin') && !cors) {
			return Response.json({ error: 'origin is not trusted' }, { status: 403 });
		}

		const response = await this.route(request, url, subPath, config);
		if (!cors) return response;
		const headers = new Headers(response.headers);
		cors.forEach((value, key) => headers.set(key, value));
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}

	private async route(
		request: Request,
		url: URL,
		subPath: string,
		config: CollectionConfig,
	): Promise<Response> {
		if (subPath === '/subscribe' && request.method === 'GET') {
			return this.acceptSubscriber(request);
		}

		if (subPath === '/documents' && request.method === 'POST') {
			return this.guarded(request, config.writeAccess, config.writePermission, (owner) =>
				this.handleCreate(request, owner),
			);
		}
		if (subPath === '/query' && request.method === 'POST') {
			return this.guarded(request, config.readAccess, config.readPermission, (owner) =>
				this.handleQuery(request, owner),
			);
		}
		if (subPath === '/aggregate' && request.method === 'POST') {
			return this.guarded(request, config.readAccess, config.readPermission, (owner) =>
				this.handleAggregate(request, owner),
			);
		}
		if (subPath === '/export' && request.method === 'GET') {
			return this.guarded(request, config.readAccess, config.readPermission, (owner) =>
				Promise.resolve(this.handleExport(owner)),
			);
		}

		const doc = subPath.match(/^\/documents\/([^/]+)$/);
		if (doc) {
			const docId = decodeURIComponent(doc[1]);
			switch (request.method) {
				case 'GET':
					return this.guarded(request, config.readAccess, config.readPermission, (owner) =>
						this.handleGet(docId, owner),
					);
				case 'PUT':
				case 'PATCH':
					return this.guarded(request, config.writeAccess, config.writePermission, (owner) =>
						this.handleWrite(request, docId, owner),
					);
				case 'DELETE':
					return this.guarded(request, config.writeAccess, config.writePermission, (owner) =>
						this.handleDelete(docId, owner),
					);
			}
		}

		return Response.json({ error: 'not found' }, { status: 404 });
	}

	/**
	 * Access-mode gate. `owner` is null for public/auth requests and the JWT
	 * subject for owner-mode ones (which scopes every read and write). A
	 * required permission is checked against the verified token's claim -
	 * public mode never sees a token, so permissions only bind auth/owner.
	 */
	private async guarded(
		request: Request,
		mode: AccessMode,
		permission: string | null,
		handler: (owner: string | null) => Promise<Response>,
	): Promise<Response> {
		if (mode === 'public') return handler(null);

		const header = request.headers.get('authorization');
		const token = header?.match(/^Bearer (.+)$/i)?.[1];
		if (!token) {
			return Response.json({ error: 'a project token is required' }, { status: 401 });
		}

		const verifier = this.getVerifier();
		const result = await verifier.verify(token);
		if (!result.ok) {
			if (result.code === 'not-configured') {
				return Response.json({ error: 'auth verification is not configured' }, { status: 503 });
			}
			return Response.json({ error: 'invalid or expired token' }, { status: 401 });
		}

		// 403, not 401: the token is valid, it just lacks the right.
		if (!hasPermission(permission, result.claims.permissions)) {
			return Response.json(
				{ error: 'the token does not carry the required permission' },
				{ status: 403 },
			);
		}

		return handler(mode === 'owner' ? result.claims.sub : null);
	}

	// -------------------------------------------------------------------------
	// Document handlers

	private async handleCreate(request: Request, owner: string | null): Promise<Response> {
		const body = createDocumentSchema.safeParse(await request.json().catch(() => null));
		if (!body.success) {
			return Response.json(
				{ error: 'invalid document', issues: body.error.issues },
				{ status: 400 },
			);
		}

		const sizeError = this.checkDocSize(body.data.data);
		if (sizeError) return sizeError;
		const rulesError = this.checkRules(body.data.data);
		if (rulesError) return rulesError;

		if (this.config?.demo) {
			const total = await this.getDocCount();
			if (total >= DEMO_MAX_DOCS_PER_COLLECTION) {
				return Response.json(
					{ error: `demo collections are capped at ${DEMO_MAX_DOCS_PER_COLLECTION} documents` },
					{ status: 429 },
				);
			}
		}

		const id = body.data.id ?? crypto.randomUUID();
		const [existing] = await this.db.select().from(documents).where(eq(documents.id, id)).limit(1);
		if (existing) {
			return Response.json({ error: 'a document with that id already exists' }, { status: 409 });
		}

		const written = await this.writeDocument(id, body.data.data, {
			mode: 'replace',
			owner,
			upsert: true,
		});
		return Response.json(written, { status: 201 });
	}

	private async handleGet(docId: string, owner: string | null): Promise<Response> {
		const [row] = await this.db.select().from(documents).where(eq(documents.id, docId)).limit(1);
		// Owner mode 404s on other people's documents rather than 403: their
		// existence is itself private.
		if (!row || (owner && row.owner !== owner)) {
			return Response.json({ error: 'no such document' }, { status: 404 });
		}
		return Response.json(toDto(row));
	}

	private async handleWrite(request: Request, docId: string, owner: string | null) {
		const body = documentDataSchema.safeParse(await request.json().catch(() => null));
		if (!body.success) {
			return Response.json(
				{ error: 'invalid document', issues: body.error.issues },
				{ status: 400 },
			);
		}

		const [existing] = await this.db
			.select()
			.from(documents)
			.where(eq(documents.id, docId))
			.limit(1);
		if (!existing || (owner && existing.owner !== owner)) {
			return Response.json({ error: 'no such document' }, { status: 404 });
		}

		const merged =
			request.method === 'PATCH'
				? { ...(JSON.parse(existing.data) as Record<string, unknown>), ...body.data }
				: body.data;
		const sizeError = this.checkDocSize(merged);
		if (sizeError) return sizeError;
		// PATCH validates the merged result: a merge can never sneak an invalid
		// document past rules the same body would fail on create.
		const rulesError = this.checkRules(merged);
		if (rulesError) return rulesError;

		const written = await this.writeDocument(docId, merged, {
			mode: 'replace',
			owner: existing.owner,
			upsert: false,
		});
		return Response.json(written);
	}

	private async handleDelete(docId: string, owner: string | null): Promise<Response> {
		const deleted = await this.deleteDocument(docId, owner);
		if (!deleted) return Response.json({ error: 'no such document' }, { status: 404 });
		return Response.json({ deleted: true });
	}

	private async handleQuery(request: Request, owner: string | null): Promise<Response> {
		const parsed = querySchema.safeParse(await request.json().catch(() => null));
		if (!parsed.success) {
			return Response.json(
				{ error: 'invalid query', issues: parsed.error.issues },
				{ status: 400 },
			);
		}
		return Response.json(await this.runQuery(parsed.data, owner));
	}

	private async handleAggregate(request: Request, owner: string | null): Promise<Response> {
		const parsed = aggregateRequestSchema.safeParse(await request.json().catch(() => null));
		if (!parsed.success) {
			return Response.json(
				{ error: 'invalid aggregate request', issues: parsed.error.issues },
				{ status: 400 },
			);
		}
		return Response.json(this.runAggregate(parsed.data, owner));
	}

	/**
	 * NDJSON export of every readable document, gated exactly like a query
	 * (owner mode exports only the caller's documents). Streamed in keyset
	 * pages so a 10 GB collection never materializes in memory.
	 */
	private handleExport(owner: string | null): Response {
		const collection = this.config?.collection ?? 'collection';
		const encoder = new TextEncoder();
		const nextRows = (after: string | null) => this.exportRows(after, EXPORT_CHUNK, owner);
		let afterId: string | null = null;
		let done = false;

		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (done) return;
				const rows = nextRows(afterId);
				for (const doc of rows) controller.enqueue(encoder.encode(`${JSON.stringify(doc)}\n`));
				if (rows.length < EXPORT_CHUNK) {
					done = true;
					controller.close();
				} else {
					afterId = rows[rows.length - 1].id;
				}
			},
		});

		return new Response(stream, {
			headers: {
				'content-type': 'application/x-ndjson',
				'content-disposition': `attachment; filename="${collection}.ndjson"`,
			},
		});
	}

	private checkDocSize(data: Record<string, unknown>): Response | null {
		const issue = this.docSizeIssue(data);
		return issue ? Response.json({ error: issue }, { status: 413 }) : null;
	}

	private docSizeIssue(data: Record<string, unknown>): string | null {
		const bytes = new TextEncoder().encode(JSON.stringify(data)).byteLength;
		const cap = this.config?.demo ? DEMO_MAX_DOC_BYTES : MAX_DOC_BYTES;
		if (bytes > cap) {
			return `document data is limited to ${cap} bytes${this.config?.demo ? ' in demo projects' : ''}`;
		}
		return null;
	}

	/** Rules-lite enforcement for the public write path; null when it passes. */
	private checkRules(data: Record<string, unknown>): Response | null {
		const validator = this.config?.validator;
		if (!validator) return null;
		const issues = validateDocument(validator, data);
		if (!issues.length) return null;
		return Response.json({ error: 'document failed validation', issues }, { status: 400 });
	}

	// -------------------------------------------------------------------------
	// Write path: every mutation computes old/new and notifies subscribers

	private async writeDocument(
		id: string,
		data: Record<string, unknown>,
		options: {
			mode: 'replace';
			owner: string | null | undefined;
			upsert: boolean;
			/** Import fidelity: keep the exported timestamps instead of now. */
			createdAt?: Date;
			updatedAt?: Date;
			/** Import fidelity: overwrite the owner column on update too. */
			replaceOwner?: boolean;
		},
	): Promise<DbDocument> {
		const [before] = await this.db.select().from(documents).where(eq(documents.id, id)).limit(1);
		const now = new Date();
		const serialized = JSON.stringify(data);

		let row: DocumentRow;
		if (before) {
			[row] = await this.db
				.update(documents)
				.set({
					data: serialized,
					updatedAt: options.updatedAt ?? now,
					...(options.replaceOwner ? { owner: options.owner ?? null } : {}),
				})
				.where(eq(documents.id, id))
				.returning();
		} else {
			[row] = await this.db
				.insert(documents)
				.values({
					id,
					data: serialized,
					owner: options.owner ?? null,
					createdAt: options.createdAt ?? now,
					updatedAt: options.updatedAt ?? now,
				})
				.returning();
		}

		this.writeDbEvent(before ? 'doc.updated' : 'doc.created');
		await this.notifySubscribers(before ?? null, row);
		this.scheduleStatsReport();
		return toDto(row);
	}

	private async deleteDocument(id: string, owner: string | null): Promise<boolean> {
		const [before] = await this.db.select().from(documents).where(eq(documents.id, id)).limit(1);
		if (!before || (owner && before.owner !== owner)) return false;

		await this.db.delete(documents).where(eq(documents.id, id));
		this.writeDbEvent('doc.deleted');
		await this.notifySubscribers(before, null);
		this.scheduleStatsReport();
		return true;
	}

	// -------------------------------------------------------------------------
	// Query execution

	private async runQuery(
		query: Query,
		ownerSub: string | null,
	): Promise<{ docs: DbDocument[]; nextCursor?: string }> {
		const cursor: DecodedCursor | null = query.cursor ? decodeCursor(query.cursor) : null;
		const compiled = compileQuery(query, { ownerSub, cursor });

		const rows = this.rawQuery(
			`SELECT id, data, owner, created_at, updated_at FROM documents ` +
				`WHERE ${compiled.whereSql} ORDER BY ${compiled.orderSql} LIMIT ?`,
			[...compiled.params, compiled.limit],
		);

		const docs = rows.map(rowToDto);
		const result: { docs: DbDocument[]; nextCursor?: string } = { docs };
		if (docs.length === compiled.limit && docs.length > 0) {
			const last = rows[rows.length - 1];
			result.nextCursor = encodeCursor({
				values: (query.orderBy ?? []).map((order) =>
					jsonValueAtPath(last.data as string, order.field),
				),
				id: last.id as string,
			});
		}
		return result;
	}

	private runAggregate(request: AggregateRequest, ownerSub: string | null): AggregateResult {
		const compiled = compileAggregate(request, { ownerSub });
		const [row] = this.rawQuery(compiled.sql, compiled.params);
		const results: Record<string, number | null> = {};
		compiled.aliases.forEach((alias, index) => {
			const value = row?.[`agg_${index}`];
			results[alias] = typeof value === 'number' ? value : null;
		});
		return { results };
	}

	/**
	 * Keyset page in id order for exports. Not a point-in-time snapshot:
	 * writes racing the export may or may not appear, but keyset pagination
	 * guarantees each id shows up at most once.
	 */
	private exportRows(afterId: string | null, limit: number, owner: string | null): DbDocument[] {
		const conditions: string[] = [];
		const params: unknown[] = [];
		if (afterId !== null) {
			conditions.push('id > ?');
			params.push(afterId);
		}
		if (owner) {
			conditions.push('owner = ?');
			params.push(owner);
		}
		return this.rawQuery(
			`SELECT id, data, owner, created_at, updated_at FROM documents ` +
				`WHERE ${conditions.length ? conditions.join(' AND ') : '1=1'} ORDER BY id ASC LIMIT ?`,
			[...params, limit],
		).map(rowToDto);
	}

	private rawQuery(sql: string, params: unknown[]): Record<string, unknown>[] {
		// The SQL text is assembled ONLY from compileQuery output, whose field
		// paths are regex-validated; every value is a bound parameter.
		return this.ctx.storage.sql
			.exec(sql, ...(params as (string | number | null)[]))
			.toArray() as Record<string, unknown>[];
	}

	// -------------------------------------------------------------------------
	// Live queries

	private async acceptSubscriber(request: Request): Promise<Response> {
		if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
			return Response.json({ error: 'expected a WebSocket upgrade' }, { status: 426 });
		}

		const pair = new WebSocketPair();
		const connId = crypto.randomUUID();
		// The tag is the connection id; the attachment carries nothing else.
		// Everything a woken instance needs lives in the subscriptions table.
		this.ctx.acceptWebSocket(pair[1], [connId]);
		pair[1].serializeAttachment({ connId });

		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
		const connId = this.connIdOf(ws);
		if (!connId) return;

		let frame;
		try {
			frame = clientFrameSchema.parse(JSON.parse(typeof raw === 'string' ? raw : ''));
		} catch {
			this.send(ws, {
				type: 'error',
				code: 'invalid-frame',
				message: 'frames are JSON subscribe/unsubscribe messages',
			});
			return;
		}

		if (frame.type === 'unsubscribe') {
			await this.db
				.delete(subscriptions)
				.where(and(eq(subscriptions.connId, connId), eq(subscriptions.subId, frame.id)));
			this.send(ws, { type: 'unsubscribed', id: frame.id });
			return;
		}

		await this.handleSubscribe(ws, connId, frame);
	}

	private async handleSubscribe(
		ws: WebSocket,
		connId: string,
		frame: (typeof subscribeFrameSchema)['_output'],
	): Promise<void> {
		const config = this.config;
		if (!config) {
			this.send(ws, { type: 'error', id: frame.id, code: 'internal', message: 'not configured' });
			return;
		}

		// Read-mode gate, mirroring the REST guard.
		let ownerSub: string | null = null;
		let tokenExp: number | null = null;
		if (config.readAccess !== 'public') {
			if (!frame.token) {
				this.send(ws, {
					type: 'error',
					id: frame.id,
					code: 'unauthorized',
					message: 'this collection requires a project token to subscribe',
				});
				return;
			}
			const result = await this.getVerifier().verify(frame.token);
			if (!result.ok) {
				this.send(ws, {
					type: 'error',
					id: frame.id,
					code: 'unauthorized',
					message:
						result.code === 'not-configured'
							? 'auth verification is not configured'
							: 'invalid or expired token',
				});
				return;
			}
			// Mirror the REST guard: a required permission binds subscriptions too.
			if (!hasPermission(config.readPermission, result.claims.permissions)) {
				this.send(ws, {
					type: 'error',
					id: frame.id,
					code: 'unauthorized',
					message: 'the token does not carry the required permission',
				});
				return;
			}
			ownerSub = config.readAccess === 'owner' ? result.claims.sub : null;
			tokenExp = result.exp;
		}

		const cap = config.demo
			? DEMO_MAX_SUBSCRIPTIONS_PER_CONNECTION
			: MAX_SUBSCRIPTIONS_PER_CONNECTION;
		const [existing] = await this.db
			.select({ value: count() })
			.from(subscriptions)
			.where(eq(subscriptions.connId, connId));
		if ((existing?.value ?? 0) >= cap) {
			this.send(ws, {
				type: 'error',
				id: frame.id,
				code: 'subscription-limit',
				message: `a connection is limited to ${cap} subscriptions`,
			});
			return;
		}

		const snapshot = await this.runQuery(frame.query, ownerSub);
		this.send(ws, { type: 'snapshot', id: frame.id, docs: snapshot.docs });

		await this.db
			.insert(subscriptions)
			.values({
				connId,
				subId: frame.id,
				query: JSON.stringify(frame.query),
				ownerSub,
				tokenExp,
				lastMembership: isWindowed(frame.query)
					? JSON.stringify(snapshot.docs.map((doc) => doc.id))
					: null,
				createdAt: new Date(),
			})
			.onConflictDoUpdate({
				target: [subscriptions.connId, subscriptions.subId],
				set: {
					query: JSON.stringify(frame.query),
					ownerSub,
					tokenExp,
					lastMembership: isWindowed(frame.query)
						? JSON.stringify(snapshot.docs.map((doc) => doc.id))
						: null,
				},
			});

		this.writeDbEvent('subscription.opened');
	}

	async webSocketClose(ws: WebSocket): Promise<void> {
		await this.dropConnection(ws);
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		await this.dropConnection(ws);
	}

	private async dropConnection(ws: WebSocket): Promise<void> {
		const connId = this.connIdOf(ws);
		if (!connId) return;
		await this.db.delete(subscriptions).where(eq(subscriptions.connId, connId));
		this.writeDbEvent('subscription.closed');
	}

	private connIdOf(ws: WebSocket): string | null {
		const attachment = ws.deserializeAttachment() as { connId?: string } | null;
		return attachment?.connId ?? null;
	}

	private send(ws: WebSocket, frame: ServerFrame): void {
		try {
			ws.send(JSON.stringify(frame));
		} catch {
			// a half-closed socket: close cleanup will prune its rows
		}
	}

	/**
	 * The matching pass every mutation pays. Unlimited queries diff the
	 * predicate on old/new. Windowed queries (orderBy+limit) re-run the query
	 * only when the write could have changed membership, then diff the id set
	 * against lastMembership - which is what gets displacement right: a doc
	 * pushed out by an insert emits `removed`, one pulled in by a delete
	 * emits `added`.
	 */
	private async notifySubscribers(
		before: DocumentRow | null,
		after: DocumentRow | null,
	): Promise<void> {
		const rows = await this.db.select().from(subscriptions);
		if (!rows.length) return;

		const nowSeconds = Math.floor(Date.now() / 1000);
		const beforeDoc = before ? toDto(before) : null;
		const afterDoc = after ? toDto(after) : null;

		for (const sub of rows) {
			const sockets = this.ctx.getWebSockets(sub.connId);
			if (!sockets.length) {
				// Connection died without a close event (eviction); prune lazily.
				await this.db.delete(subscriptions).where(eq(subscriptions.connId, sub.connId));
				continue;
			}
			const ws = sockets[0];

			if (sub.tokenExp && sub.tokenExp < nowSeconds) {
				this.send(ws, {
					type: 'error',
					id: sub.subId,
					code: 'token-expired',
					message: 'the token this subscription was opened with has expired',
				});
				await this.db
					.delete(subscriptions)
					.where(and(eq(subscriptions.connId, sub.connId), eq(subscriptions.subId, sub.subId)));
				continue;
			}

			let query: Query;
			try {
				query = querySchema.parse(JSON.parse(sub.query));
			} catch {
				continue;
			}

			const matchedBefore = beforeDoc ? matchesQuery(query, beforeDoc, sub.ownerSub) : false;
			const matchedAfter = afterDoc ? matchesQuery(query, afterDoc, sub.ownerSub) : false;
			if (!matchedBefore && !matchedAfter) continue;

			if (isWindowed(query)) {
				await this.notifyWindowed(ws, sub.connId, sub.subId, query, sub, afterDoc, beforeDoc);
				continue;
			}

			if (!matchedBefore && matchedAfter && afterDoc) {
				this.send(ws, { type: 'change', id: sub.subId, kind: 'added', doc: afterDoc });
			} else if (matchedBefore && matchedAfter && afterDoc) {
				this.send(ws, { type: 'change', id: sub.subId, kind: 'modified', doc: afterDoc });
			} else if (matchedBefore && !matchedAfter && beforeDoc) {
				this.send(ws, { type: 'change', id: sub.subId, kind: 'removed', doc: beforeDoc });
			}
		}
	}

	private async notifyWindowed(
		ws: WebSocket,
		connId: string,
		subId: string,
		query: Query,
		sub: typeof subscriptions.$inferSelect,
		afterDoc: DbDocument | null,
		beforeDoc: DbDocument | null,
	): Promise<void> {
		const fresh = await this.runQuery(query, sub.ownerSub);
		const freshIds = fresh.docs.map((doc) => doc.id);
		const freshSet = new Set(freshIds);
		const previous: string[] = sub.lastMembership ? JSON.parse(sub.lastMembership) : [];
		const previousSet = new Set(previous);
		const byId = new Map(fresh.docs.map((doc) => [doc.id, doc]));

		for (const id of freshIds) {
			if (!previousSet.has(id)) {
				const doc = byId.get(id);
				if (doc) this.send(ws, { type: 'change', id: subId, kind: 'added', doc });
			}
		}
		for (const id of previous) {
			if (!freshSet.has(id)) {
				// Displaced out of the window, or deleted. Prefer the written doc's
				// old value; otherwise fetch the still-existing displaced doc.
				const doc = beforeDoc?.id === id ? beforeDoc : ((await this.fetchDoc(id)) ?? beforeDoc);
				if (doc) this.send(ws, { type: 'change', id: subId, kind: 'removed', doc });
			}
		}
		if (afterDoc && freshSet.has(afterDoc.id) && previousSet.has(afterDoc.id)) {
			this.send(ws, { type: 'change', id: subId, kind: 'modified', doc: afterDoc });
		}

		await this.db
			.update(subscriptions)
			.set({ lastMembership: JSON.stringify(freshIds) })
			.where(and(eq(subscriptions.connId, connId), eq(subscriptions.subId, subId)));
	}

	private async fetchDoc(id: string): Promise<DbDocument | null> {
		const [row] = await this.db.select().from(documents).where(eq(documents.id, id)).limit(1);
		return row ? toDto(row) : null;
	}

	// -------------------------------------------------------------------------
	// Config, auth, CORS, analytics, stats

	/** Cached config, or a one-time lazy pull from the parent on first touch. */
	private async ensureConfig(
		projectId: string,
		collection: string,
	): Promise<CollectionConfig | null> {
		if (this.config) return this.config;

		try {
			const parent = await this.parentStub(projectId);
			const config = await parent.getCollectionConfig(collection, { autoCreate: true });
			if (config) await this.configure(config);
			return this.config;
		} catch {
			return null;
		}
	}

	private async parentStub(projectId: string) {
		const namespace = this.env.DbAgent as unknown as DurableObjectNamespace<DbAgent>;
		return namespace.get(namespace.idFromName(projectId));
	}

	private getVerifier(): ProjectJwtVerifier {
		if (!this.verifier) {
			this.verifier = new ProjectJwtVerifier(
				this.ctx.storage,
				this.env as { AUTH_AGENT?: Fetcher },
				this.config?.projectId ?? this.ctx.id.name?.split(':')[0] ?? '',
			);
		}
		return this.verifier;
	}

	private corsHeaders(request: Request): Headers | null {
		const origin = request.headers.get('origin');
		const sameOrigin = origin === new URL(request.url).origin;
		const trusted = [
			...(this.env.TRUSTED_ORIGINS ?? '')
				.split(',')
				.map((entry) => entry.trim())
				.filter(Boolean),
			...(this.config?.allowedOrigins ?? []),
		];
		if (!origin || (!sameOrigin && !trusted.includes(origin))) return null;
		return new Headers({
			'access-control-allow-origin': origin,
			'access-control-allow-credentials': 'true',
			'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
			'access-control-allow-headers': 'authorization, content-type',
			vary: 'Origin',
		});
	}

	/** Best-effort analytics; a metrics failure never fails the operation. */
	private writeDbEvent(eventType: string): void {
		const config = this.config;
		try {
			this.env.DB_EVENTS?.writeDataPoint({
				indexes: [config?.projectId ?? 'unknown'],
				// Schema: event, collection, country, subject, reserved.
				blobs: [eventType, config?.collection ?? 'unknown', 'unknown', 'none', 'none'],
				doubles: [1],
			});
		} catch {
			// never let metrics break a write
		}
	}

	/** Debounced absolute-count report; self-healing because it is absolute. */
	private scheduleStatsReport(): void {
		if (this.statsTimer) return;
		this.statsTimer = setTimeout(() => {
			this.statsTimer = null;
			void this.reportStats();
		}, STATS_REPORT_MS);
	}

	private async reportStats(): Promise<void> {
		const config = this.config;
		if (!config) return;
		try {
			const parent = await this.parentStub(config.projectId);
			await parent.reportCollectionStats(config.collection, { docs: await this.getDocCount() });
		} catch {
			// best-effort: the next write re-arms the timer and corrects the count
		}
	}
}

function toDto(row: DocumentRow): DbDocument {
	return {
		id: row.id,
		data: JSON.parse(row.data) as Record<string, unknown>,
		owner: row.owner,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

function rowToDto(row: Record<string, unknown>): DbDocument {
	return {
		id: row.id as string,
		data: JSON.parse(row.data as string) as Record<string, unknown>,
		owner: (row.owner as string | null) ?? null,
		createdAt: new Date(row.created_at as number).toISOString(),
		updatedAt: new Date(row.updated_at as number).toISOString(),
	};
}

function jsonValueAtPath(dataJson: string, field: string): unknown {
	try {
		const data = JSON.parse(dataJson) as Record<string, unknown>;
		let value: unknown = data;
		for (const segment of field.split('.')) {
			if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
			value = (value as Record<string, unknown>)[segment];
		}
		return value ?? null;
	} catch {
		return null;
	}
}
