import * as Sentry from '@sentry/cloudflare';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import migrations from './migrations';
import { checkAccess, corsHeadersFor, drainUnusedBody, withCors } from './access';
import { collectionMeta } from './db/schema';
import { ProjectJwtVerifier } from './jwt';
import { LiveShard, type LiveGate } from './live';
import { getPath, encodeCursor, decodeCursor, type DecodedCursor } from './query';
import {
	applyColumnDefaults,
	isDuplicateColumnError,
	planDdl,
	quoteIdent,
	rowDataFromSql,
	selectList,
	toSqlValue,
	uniqueViolationColumn,
	validateRow,
} from './table-schema';
import { compileTableQuery } from './table-query';
import { ulid } from './ulid';
import {
	createDocumentSchema,
	documentDataSchema,
	querySchema,
	storedTableMetaSchema,
	tableConfigSchema,
	MAX_DOC_BYTES,
	type DbRow,
	type Query,
	type TableColumn,
	type TableConfig,
	type TableMeta,
} from './schemas';
import type { DbAgent } from './agent';

/**
 * One SQL table: typed columns over a physical SQLite table NAMED AFTER the
 * declared table with plain reserved system columns (id, owner, created_at,
 * updated_at) - the ORM-compatibility contract: drizzle/prisma-generated SQL
 * reads and writes the real schema unmodified. The live-query engine and the
 * access gate are inherited from LiveShard/access.ts, shared verbatim with
 * DbCollection.
 *
 * Instance name: `<projectId>:<tableName>` in the DbTable namespace. Tables
 * are schema-first: there is NO auto-creation - an instance with no cached
 * meta pulls the parent's registry once, and an unregistered table answers
 * 404. The cached meta carries the pushed config AND the applied-schema
 * record (`appliedColumns`), which replaces introspection because
 * pragma_table_info is SQLITE_AUTH; configure() plans the DDL diff between
 * the two and only advances the record once every statement landed.
 */

const DEMO_MAX_ROWS_PER_TABLE = 200;
const DEMO_MAX_ROW_BYTES = 8 * 1024;
const STATS_REPORT_MS = 500;

/** Compile refusals surface as 400s at REST/RPC boundaries. */
class TableQueryError extends Error {}

export class DbTable extends LiveShard {
	private meta: TableMeta | null = null;
	private verifier: ProjectJwtVerifier | null = null;
	private statsTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Idempotent - drizzle tracks applied migrations in its own table. Only
		// `subscriptions` and `collection_meta` are used here; the physical data
		// table is created by configure() from the declared columns and lives
		// entirely outside drizzle.
		ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);
			this.meta = storedTableMetaSchema.parse(await this.loadStoredMeta());
		});
		// Absolute-count self-healing on every wake, exactly like collections.
		this.scheduleStatsReport();
	}

	private async loadStoredMeta(): Promise<unknown> {
		const [row] = await this.db.select().from(collectionMeta).limit(1);
		if (!row) return null;
		try {
			return JSON.parse(row.config);
		} catch {
			return null;
		}
	}

	private get config(): TableConfig | null {
		return this.meta?.config ?? null;
	}

	private get columns(): TableColumn[] {
		return this.meta?.config.columns ?? [];
	}

	// -------------------------------------------------------------------------
	// RPC surface (parent and worker entrypoint only - never public HTTP)

	/**
	 * Parent push on declare/config change. Stale versions are ignored. The
	 * DDL diff between the applied record and the declared columns runs FIRST;
	 * `appliedColumns` only advances when every statement landed, so a partial
	 * failure retries the remainder (ADD COLUMN tolerates "duplicate column
	 * name" - the already-applied detector - and index statements are
	 * IF [NOT] EXISTS). A genuine DDL failure (e.g. uniquifying a column with
	 * duplicate data) throws with SQLite's message for the parent to surface,
	 * and the previous meta stays authoritative.
	 */
	async configure(input: unknown): Promise<void> {
		const parsed = tableConfigSchema.parse(input);
		if (this.meta && parsed.configVersion < this.meta.config.configVersion) return;

		const applied = this.meta?.appliedColumns ?? null;
		const plan = planDdl(parsed.table, applied, parsed.columns);
		if (!plan.ok) {
			// The parent refuses destructive diffs before pushing; reaching this
			// is defensive, not expected.
			throw new Error(plan.reason);
		}
		for (const statement of plan.statements) {
			try {
				this.ctx.storage.sql.exec(statement);
			} catch (error) {
				if (isDuplicateColumnError(error)) continue;
				throw error;
			}
		}

		this.meta = { config: parsed, appliedColumns: parsed.columns };
		this.verifier = null;
		const serialized = JSON.stringify(this.meta);
		await this.db
			.insert(collectionMeta)
			.values({ id: 1, config: serialized, updatedAt: new Date() })
			.onConflictDoUpdate({
				target: collectionMeta.id,
				set: { config: serialized, updatedAt: new Date() },
			});
	}

	/** Operator query over the dashboard proxy (parent-forwarded). Compile
	 * refusals come back as a discriminated result - RPC error text is not a
	 * contract - and the parent answers 400 with the message. */
	async adminQuery(
		input: unknown,
	): Promise<{ ok: true; docs: DbRow[]; nextCursor?: string } | { ok: false; error: string }> {
		const query = querySchema.parse(input);
		try {
			return { ok: true, ...(await this.runQuery(query, null)) };
		} catch (error) {
			if (error instanceof TableQueryError) return { ok: false, error: error.message };
			throw error;
		}
	}

	/**
	 * Operator upsert (dashboard row editor). Structure always validates -
	 * the schema IS the storage - but policy rules (bounds/enum) are bypassed
	 * exactly like document validators on operator surfaces. With `ifAbsent`,
	 * an existing id reports a conflict instead of replacing.
	 */
	async adminPut(
		id: string,
		data: unknown,
		ifAbsent = false,
	): Promise<DbRow | { conflict: true } | { invalid: string[] }> {
		const parsed = documentDataSchema.parse(data);
		if (ifAbsent && this.rowById(id)) return { conflict: true };

		const full = applyColumnDefaults(this.columns, parsed);
		const issues = validateRow(this.columns, full, { skipPolicy: true });
		if (issues.length) return { invalid: issues };

		return this.writeRow(id, full, { owner: undefined });
	}

	/** Operator delete. Returns false when the row does not exist. */
	async adminDelete(id: string): Promise<boolean> {
		return this.deleteRow(id, null);
	}

	/** Exact live count, for parent-initiated reconciliation. */
	async getRowCount(): Promise<number> {
		if (!this.meta) return 0;
		const [row] = this.ctx.storage.sql
			.exec(`SELECT COUNT(*) AS n FROM ${quoteIdent(this.meta.config.table)}`)
			.toArray() as { n: number }[];
		return row?.n ?? 0;
	}

	/** Erase this table - the collection destroy sequence verbatim. */
	async destroy(): Promise<void> {
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.close(1001, 'table erased');
			} catch {
				// closing a half-dead socket must not block the erase
			}
		}
		await this.ctx.storage.deleteAll();
		await this.ctx.storage.deleteAlarm();
		setTimeout(() => this.ctx.abort(), 0);
	}

	// -------------------------------------------------------------------------
	// HTTP surface: /agents/db-agent/<pid>/tables/<name>/...

	async fetch(request: Request): Promise<Response> {
		// EVERY exit drains an unread body first - see drainUnusedBody.
		const response = await this.dispatch(request);
		await drainUnusedBody(request);
		return response;
	}

	private async dispatch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const match = url.pathname.match(/^\/agents\/[^/]+\/([^/]+)\/tables\/([^/]+)(\/.*)?$/);
		if (!match) return Response.json({ error: 'not found' }, { status: 404 });
		const subPath = match[3] ?? '/';

		const state = await this.ensureMeta(match[1], match[2]);
		if (state === 'unknown') {
			// Schema-first: nothing auto-creates a table.
			return Response.json({ error: 'no such table - declare it first' }, { status: 404 });
		}
		if (state === 'unavailable') {
			return Response.json({ error: 'table is unavailable' }, { status: 503 });
		}
		const config = state;

		const cors = corsHeadersFor(request, this.env.TRUSTED_ORIGINS, config.allowedOrigins);
		if (request.method === 'OPTIONS') {
			return cors
				? new Response(null, { status: 204, headers: cors })
				: Response.json({ error: 'origin is not trusted' }, { status: 403 });
		}
		if (request.headers.get('origin') && !cors) {
			return Response.json({ error: 'origin is not trusted' }, { status: 403 });
		}

		return withCors(await this.route(request, subPath, config), cors);
	}

	private async route(request: Request, subPath: string, config: TableConfig): Promise<Response> {
		if (subPath === '/subscribe' && request.method === 'GET') {
			return this.acceptSubscriber(request);
		}

		if (subPath === '/rows' && request.method === 'POST') {
			return this.guarded(request, 'write', config, (owner) => this.handleCreate(request, owner));
		}
		if (subPath === '/query' && request.method === 'POST') {
			return this.guarded(request, 'read', config, (owner) => this.handleQuery(request, owner));
		}

		const row = subPath.match(/^\/rows\/([^/]+)$/);
		if (row) {
			const rowId = decodeURIComponent(row[1]);
			switch (request.method) {
				case 'GET':
					return this.guarded(request, 'read', config, (owner) => this.handleGet(rowId, owner));
				case 'PUT':
				case 'PATCH':
					return this.guarded(request, 'write', config, (owner) =>
						this.handleWrite(request, rowId, owner),
					);
				case 'DELETE':
					return this.guarded(request, 'write', config, (owner) => this.handleDelete(rowId, owner));
			}
		}

		return Response.json({ error: 'not found' }, { status: 404 });
	}

	private async guarded(
		request: Request,
		side: 'read' | 'write',
		config: TableConfig,
		handler: (owner: string | null) => Promise<Response>,
	): Promise<Response> {
		const decision = await checkAccess(
			request,
			side === 'read' ? config.readAccess : config.writeAccess,
			side === 'read' ? config.readPermission : config.writePermission,
			this.getVerifier(),
		);
		if (!decision.ok) return decision.response;
		return handler(decision.owner);
	}

	// -------------------------------------------------------------------------
	// Row handlers

	private async handleCreate(request: Request, owner: string | null): Promise<Response> {
		const body = createDocumentSchema.safeParse(await request.json().catch(() => null));
		if (!body.success) {
			return Response.json({ error: 'invalid row', issues: body.error.issues }, { status: 400 });
		}

		const full = applyColumnDefaults(this.columns, body.data.data);
		const invalid = this.checkRow(full);
		if (invalid) return invalid;

		if (this.config?.demo && (await this.getRowCount()) >= DEMO_MAX_ROWS_PER_TABLE) {
			return Response.json(
				{ error: `demo tables are capped at ${DEMO_MAX_ROWS_PER_TABLE} rows` },
				{ status: 429 },
			);
		}

		const id = body.data.id ?? ulid();
		if (this.rowById(id)) {
			return Response.json({ error: 'a row with that id already exists' }, { status: 409 });
		}

		try {
			const written = await this.writeRow(id, full, { owner });
			return Response.json(written, { status: 201 });
		} catch (error) {
			return this.uniqueViolationResponse(error) ?? this.rethrow(error);
		}
	}

	private async handleGet(rowId: string, owner: string | null): Promise<Response> {
		const row = this.rowById(rowId);
		// Owner mode 404s on other people's rows: their existence is private.
		if (!row || (owner && row.owner !== owner)) {
			return Response.json({ error: 'no such row' }, { status: 404 });
		}
		return Response.json(this.toDto(row));
	}

	private async handleWrite(request: Request, rowId: string, owner: string | null) {
		const body = documentDataSchema.safeParse(await request.json().catch(() => null));
		if (!body.success) {
			return Response.json({ error: 'invalid row', issues: body.error.issues }, { status: 400 });
		}

		const existing = this.rowById(rowId);
		if (!existing || (owner && existing.owner !== owner)) {
			return Response.json({ error: 'no such row' }, { status: 404 });
		}

		// PATCH merges column-by-column over the materialized row; PUT replaces
		// (missing columns fall back to defaults/null). Both validate the final
		// row, so a merge can never sneak an invalid value past the schema.
		const replacement = applyColumnDefaults(this.columns, body.data);
		const merged =
			request.method === 'PATCH'
				? { ...rowDataFromSql(this.columns, existing), ...body.data }
				: replacement;
		const invalid = this.checkRow(merged);
		if (invalid) return invalid;

		try {
			const written = await this.writeRow(rowId, merged, {
				owner: (existing.owner as string | null) ?? null,
			});
			return Response.json(written);
		} catch (error) {
			return this.uniqueViolationResponse(error) ?? this.rethrow(error);
		}
	}

	private async handleDelete(rowId: string, owner: string | null): Promise<Response> {
		const deleted = await this.deleteRow(rowId, owner);
		if (!deleted) return Response.json({ error: 'no such row' }, { status: 404 });
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
		try {
			return Response.json(await this.runQuery(parsed.data, owner));
		} catch (error) {
			if (error instanceof TableQueryError) {
				return Response.json({ error: error.message }, { status: 400 });
			}
			throw error;
		}
	}

	/** Row size + schema validation; null when the row passes. */
	private checkRow(data: Record<string, unknown>): Response | null {
		const bytes = new TextEncoder().encode(JSON.stringify(data)).byteLength;
		const cap = this.config?.demo ? DEMO_MAX_ROW_BYTES : MAX_DOC_BYTES;
		if (bytes > cap) {
			return Response.json(
				{
					error: `row data is limited to ${cap} bytes${this.config?.demo ? ' in demo projects' : ''}`,
				},
				{ status: 413 },
			);
		}
		const issues = validateRow(this.columns, data);
		if (issues.length) {
			return Response.json({ error: 'row failed validation', issues }, { status: 400 });
		}
		return null;
	}

	/** UNIQUE violations become 409s naming the offending column. */
	private uniqueViolationResponse(error: unknown): Response | null {
		const column = uniqueViolationColumn(error);
		if (!column) return null;
		return Response.json(
			{ error: `a row with that ${column} already exists (unique column)` },
			{ status: 409 },
		);
	}

	private rethrow(error: unknown): never {
		throw error;
	}

	// -------------------------------------------------------------------------
	// Write path: every mutation computes old/new and notifies subscribers

	private async writeRow(
		id: string,
		data: Record<string, unknown>,
		options: { owner: string | null | undefined },
	): Promise<DbRow> {
		const table = this.requireTableName();
		const before = this.rowById(id);
		const now = Date.now();
		const columns = this.columns;

		const declaredNames = columns.map((column) => quoteIdent(column.name));
		const values = columns.map((column) => toSqlValue(column, data[column.name]));

		if (before) {
			this.ctx.storage.sql.exec(
				`UPDATE ${quoteIdent(table)} SET "updated_at" = ?` +
					(declaredNames.length
						? `, ${declaredNames.map((name) => `${name} = ?`).join(', ')}`
						: '') +
					` WHERE "id" = ?`,
				now,
				...values,
				id,
			);
		} else {
			this.ctx.storage.sql.exec(
				`INSERT INTO ${quoteIdent(table)} ("id", "owner", "created_at", "updated_at"` +
					(declaredNames.length ? `, ${declaredNames.join(', ')}` : '') +
					`) VALUES (?, ?, ?, ?${declaredNames.length ? `, ${declaredNames.map(() => '?').join(', ')}` : ''})`,
				id,
				options.owner ?? null,
				now,
				now,
				...values,
			);
		}

		const after = this.rowById(id);
		if (!after) throw new Error('row vanished mid-write');

		this.writeDbEvent(before ? 'row.updated' : 'row.created');
		await this.notifySubscribers(before ? this.toDto(before) : null, this.toDto(after));
		this.scheduleStatsReport();
		return this.toDto(after);
	}

	private async deleteRow(id: string, owner: string | null): Promise<boolean> {
		const table = this.requireTableName();
		const before = this.rowById(id);
		if (!before || (owner && before.owner !== owner)) return false;

		this.ctx.storage.sql.exec(`DELETE FROM ${quoteIdent(table)} WHERE "id" = ?`, id);
		this.writeDbEvent('row.deleted');
		await this.notifySubscribers(this.toDto(before), null);
		this.scheduleStatsReport();
		return true;
	}

	// -------------------------------------------------------------------------
	// Query execution

	private async runQuery(
		query: Query,
		ownerSub: string | null,
	): Promise<{ docs: DbRow[]; nextCursor?: string }> {
		const table = this.requireTableName();
		const cursor: DecodedCursor | null = query.cursor ? decodeCursor(query.cursor) : null;
		const result = compileTableQuery(query, this.columns, { ownerSub, cursor });
		if (!result.ok) throw new TableQueryError(result.error);
		const compiled = result.compiled;

		const rows = this.ctx.storage.sql
			.exec(
				`SELECT ${selectList(this.columns)} FROM ${quoteIdent(table)} ` +
					`WHERE ${compiled.whereSql} ORDER BY ${compiled.orderSql} LIMIT ?`,
				...([...compiled.params, compiled.limit] as (string | number | null)[]),
			)
			.toArray() as Record<string, unknown>[];

		const docs = rows.map((row) => this.toDto(row));
		const result2: { docs: DbRow[]; nextCursor?: string } = { docs };
		if (docs.length === compiled.limit && docs.length > 0) {
			const last = docs[docs.length - 1];
			result2.nextCursor = encodeCursor({
				values: (query.orderBy ?? []).map((order) => getPath(last.data, order.field)),
				id: last.id,
			});
		}
		return result2;
	}

	private rowById(id: string): Record<string, unknown> | null {
		if (!this.meta) return null;
		const [row] = this.ctx.storage.sql
			.exec(
				`SELECT ${selectList(this.columns)} FROM ${quoteIdent(this.meta.config.table)} WHERE "id" = ?`,
				id,
			)
			.toArray() as Record<string, unknown>[];
		return row ?? null;
	}

	private toDto(row: Record<string, unknown>): DbRow {
		return {
			id: row.id as string,
			data: rowDataFromSql(this.columns, row),
			owner: (row.owner as string | null) ?? null,
			createdAt: new Date(row.created_at as number).toISOString(),
			updatedAt: new Date(row.updated_at as number).toISOString(),
		};
	}

	private requireTableName(): string {
		const table = this.meta?.config.table;
		if (!table) throw new Error('table is not configured');
		return table;
	}

	// -------------------------------------------------------------------------
	// The LiveShard surface

	protected liveGate(): LiveGate | null {
		return this.config
			? {
					readAccess: this.config.readAccess,
					readPermission: this.config.readPermission,
					demo: this.config.demo,
				}
			: null;
	}

	/** Tables refuse subscribe queries over undeclared columns up front. */
	protected validateSubscribeQuery(query: Query): string | null {
		const result = compileTableQuery(query, this.columns);
		return result.ok ? null : result.error;
	}

	protected async runLiveQuery(query: Query, ownerSub: string | null): Promise<{ docs: DbRow[] }> {
		return this.runQuery(query, ownerSub);
	}

	protected async fetchDocById(id: string): Promise<DbRow | null> {
		const row = this.rowById(id);
		return row ? this.toDto(row) : null;
	}

	protected writeShardEvent(eventType: string): void {
		this.writeDbEvent(eventType);
	}

	// -------------------------------------------------------------------------
	// Config, auth, analytics, stats

	/** Cached meta, or a one-time lazy pull from the parent on first touch.
	 * 'unknown' = the registry has no such table (404 - schema-first);
	 * 'unavailable' = the parent could not be reached (503). */
	private async ensureMeta(
		projectId: string,
		table: string,
	): Promise<TableConfig | 'unknown' | 'unavailable'> {
		if (this.meta) return this.meta.config;

		try {
			const parent = await this.parentStub(projectId);
			const config = await parent.getTableConfig(table);
			if (!config) return 'unknown';
			await this.configure(config);
			return this.meta ? (this.meta as TableMeta).config : 'unavailable';
		} catch (error) {
			try {
				Sentry.captureException(error, {
					level: 'error',
					tags: { projectId, table, operation: 'ensure-table-meta' },
					extra: { note: 'table is answering 503 - config pull from the parent failed' },
				});
			} catch {
				// reporting must never break the request path
			}
			return 'unavailable';
		}
	}

	private async parentStub(projectId: string) {
		const namespace = this.env.DbAgent as unknown as DurableObjectNamespace<DbAgent>;
		return namespace.get(namespace.idFromName(projectId));
	}

	protected getVerifier(): ProjectJwtVerifier {
		if (!this.verifier) {
			this.verifier = new ProjectJwtVerifier(
				this.ctx.storage,
				this.env as { AUTH_AGENT?: Fetcher },
				this.config?.projectId ?? this.ctx.id.name?.split(':')[0] ?? '',
			);
		}
		return this.verifier;
	}

	/** Best-effort analytics; a metrics failure never fails the operation. */
	private writeDbEvent(eventType: string): void {
		const config = this.config;
		try {
			this.env.DB_EVENTS?.writeDataPoint({
				indexes: [config?.projectId ?? 'unknown'],
				// Schema: event, collection/table, country, subject, reserved.
				blobs: [eventType, config?.table ?? 'unknown', 'unknown', 'none', 'none'],
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
			await parent.reportTableStats(config.table, { rows: await this.getRowCount() });
		} catch {
			// best-effort: the next write re-arms the timer and corrects the count
		}
	}
}
