import * as Sentry from '@sentry/cloudflare';
import { Agent, type AgentContext } from 'agents';
import { and, asc, desc, eq, lt } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import migrations from './migrations';
import * as schema from './db/schema';
import { collections, restorePoints } from './db/schema';
import {
	aggregateRequestSchema,
	checkpointRequestSchema,
	collectionModesSchema,
	collectionNameSchema,
	demoTtlHoursSchema,
	importLineSchema,
	projectIdSchema,
	querySchema,
	restoreRequestSchema,
	settingsRequestSchema,
	tableColumnsSchema,
	tableModesSchema,
	validatorSchema,
	DEMO_PROJECT_PATTERN,
	IMPORT_RPC_CHUNK,
	MAX_IMPORT_BYTES,
	MAX_IMPORT_DOCS,
	MAX_RESTORE_POINTS,
	type AccessMode,
	type BookmarkOutcome,
	type CollectionConfig,
	type CollectionValidator,
	type DbDocument,
	type ImportLine,
	type ImportReport,
	type RestoreOutcome,
	type RestorePoint,
	type RestoreRequest,
	type TableColumn,
	type TableConfig,
} from './schemas';
import { drainUnusedBody } from './access';
import { planDdl, uniqueViolationColumn } from './table-schema';
import type { DbCollection } from './collection';
import type { DbTable } from './table';

/**
 * The per-project coordinator: owns the authoritative collection registry
 * (names, access modes, reported counts), the operator admin surface, the
 * dashboard's live state (Agents SDK state sync, consumed by AgentClient
 * exactly like the auth agent), demo TTL scheduling, and the erase fan-out
 * to its collection children.
 *
 * The hot data path never touches this class - the worker entrypoint routes
 * collection traffic straight to DbCollection instances, which cache their
 * config locally. This class is the single authority that creates children
 * and pushes config to them; a child with no config pulls it here once
 * (`getCollectionConfig({ autoCreate: true })`), which is also what heals a
 * registry row whose config push failed.
 */

const MAX_EVENTS = 50;
const MAX_COLLECTIONS = 200;
const DEMO_MAX_COLLECTIONS = 5;

/**
 * The runtime's "Application called abort() to reset Durable Object" family.
 * A destroyed/restored instance schedules abort() a tick after replying; in
 * PRODUCTION that abort can outrace the RPC reply across colos, so a
 * completed operation surfaces as this error at the caller. Local workerd
 * always flushes the reply first, which is why only deployed stacks see it.
 */
const DO_RESET_PATTERN = /abort\(\) to reset|durable object reset/i;

export function isDurableObjectReset(error: unknown): boolean {
	return DO_RESET_PATTERN.test(error instanceof Error ? error.message : String(error));
}

/** Registry rows store the validator as JSON text; unreadable = none. */
function parseStoredValidator(raw: string | null): CollectionValidator | null {
	if (!raw) return null;
	try {
		return validatorSchema.nullable().catch(null).parse(JSON.parse(raw));
	} catch {
		return null;
	}
}

/** Table rows store the declared columns as JSON text; unreadable = []. */
function parseStoredColumns(raw: string | null): TableColumn[] {
	if (!raw) return [];
	try {
		return tableColumnsSchema.parse(JSON.parse(raw));
	} catch {
		return [];
	}
}

/**
 * The kind-specific surface behind the shared shard admin actions (export,
 * import, PITR). Both engines expose the same RPC contract; the adapter is
 * what keeps the six admin routes single-sourced instead of copied per kind.
 */
interface ShardAdminOps {
	kind: 'collection' | 'table';
	row(): Promise<typeof collections.$inferSelect | null>;
	notFound(): Response;
	exportChunk(afterId?: string): Promise<{ docs: DbDocument[]; nextAfterId: string | null }>;
	importChunk(lines: ImportLine[]): Promise<ImportReport>;
	currentBookmark(): Promise<{ ok: true; bookmark: string } | { ok: false }>;
	bookmarkForTime(iso: string): Promise<BookmarkOutcome>;
	restoreTo(body: RestoreRequest): Promise<RestoreOutcome>;
	reconcileCount(): Promise<void>;
	pushShardConfig(row: typeof collections.$inferSelect): Promise<void>;
}

export interface DbActivityEvent {
	id: string;
	type:
		| 'project.provisioned'
		| 'collection.created'
		| 'collection.deleted'
		| 'collection.configured'
		| 'collection.restored'
		| 'documents.changed'
		| 'documents.imported'
		| 'table.created'
		| 'table.configured'
		| 'table.deleted'
		| 'table.restored'
		| 'rows.changed'
		| 'rows.imported';
	message: string;
	at: string;
}

export interface DbCollectionSummary {
	name: string;
	readAccess: AccessMode;
	writeAccess: AccessMode;
	readPermission: string | null;
	writePermission: string | null;
	validator: CollectionValidator | null;
	replication: 'off' | 'auto';
	docs: number;
}

export interface DbTableSummary {
	name: string;
	readAccess: AccessMode;
	writeAccess: AccessMode;
	readPermission: string | null;
	writePermission: string | null;
	columns: TableColumn[];
	replication: 'off' | 'auto';
	rows: number;
}

export interface DbAgentState {
	projectId: string;
	provisionedAt: string | null;
	allowedOrigins: string[];
	collections: DbCollectionSummary[];
	tables: DbTableSummary[];
	totalDocs: number;
	totalRows: number;
	/** Bumped on any reported change; dashboards refetch when it moves. */
	rev: number;
	totalEvents: number;
	lastEventAt: string | null;
	events: DbActivityEvent[];
}

export interface DbOverview {
	projectId: string;
	collections: DbCollectionSummary[];
	tables: DbTableSummary[];
	state: DbAgentState;
}

export class DbAgent extends Agent<Env, DbAgentState> {
	initialState: DbAgentState = {
		projectId: '',
		provisionedAt: null,
		allowedOrigins: [],
		collections: [],
		tables: [],
		totalDocs: 0,
		totalRows: 0,
		rev: 0,
		totalEvents: 0,
		lastEventAt: null,
		events: [],
	};

	db: DrizzleSqliteDODatabase<typeof schema>;

	constructor(ctx: AgentContext, env: Env) {
		super(ctx, env);
		this.db = drizzle(ctx.storage, { schema });
	}

	private get isEphemeral(): boolean {
		return this.env.DEMO_MODE === 'true' && DEMO_PROJECT_PATTERN.test(this.name);
	}

	/** A row's replication, normalized to the union. The column defaults to
	 * 'auto' (read replicas out of the box, demos included - the demo IS the
	 * pitch for this feature); 'off' is the explicit opt-out. One choke point
	 * for every config build, routing answer, and state summary. */
	private shardReplication(row: { replication: string }): 'off' | 'auto' {
		return row.replication === 'auto' ? 'auto' : 'off';
	}

	async onStart(): Promise<void> {
		// Idempotent - drizzle tracks applied migrations in its own table.
		await migrate(this.db, migrations);

		if (this.env.LOCAL_ANALYTICS) {
			await this.env.LOCAL_ANALYTICS.batch([
				this.env.LOCAL_ANALYTICS.prepare(
					`CREATE TABLE IF NOT EXISTS db_events (
						id integer PRIMARY KEY AUTOINCREMENT,
						project_id text NOT NULL,
						event_type text NOT NULL,
						collection text NOT NULL,
						timestamp integer NOT NULL
					)`,
				),
				this.env.LOCAL_ANALYTICS.prepare(
					`CREATE INDEX IF NOT EXISTS db_events_project_time ON db_events(project_id, timestamp)`,
				),
			]);
		}

		if (!this.state.projectId) {
			this.setState({
				...this.state,
				projectId: this.name,
				provisionedAt: new Date().toISOString(),
			});
			this.writeDbEvent('project.provisioned');
			this.recordEvent('project.provisioned', `database provisioned for project "${this.name}"`);
		} else {
			// Re-derive summaries from the registry on wake: persisted state can
			// predate newer summary fields (readPermission, validator, ...), and
			// broadcasting the stale shape would fail the console's overview
			// parse for exactly the projects that already hold data.
			await this.syncCollectionsState();
		}

		if (this.isEphemeral) {
			const hours = demoTtlHoursSchema.parse(this.env.DEMO_TTL_HOURS);
			// idempotent so repeated wakes reuse the existing row - the deadline
			// runs from first provision, not the visitor's last page load.
			await this.schedule(hours * 3600, 'expireDemoProject', undefined, { idempotent: true });
		}
	}

	async expireDemoProject(): Promise<void> {
		// Re-check: schedules outlive configuration changes.
		if (!this.isEphemeral) return;
		await this.destroy();
	}

	// -------------------------------------------------------------------------
	// RPC surface

	/**
	 * The child's lazy config pull. With autoCreate, an unknown collection is
	 * registered with default modes - which is how first-write auto-creation
	 * stays parent-mediated even on the direct hot path.
	 */
	async getCollectionConfig(
		name: string,
		options: { autoCreate?: boolean } = {},
	): Promise<CollectionConfig | null> {
		if (!collectionNameSchema.safeParse(name).success) return null;

		let [row] = await this.db.select().from(collections).where(eq(collections.name, name)).limit(1);
		// A name registered as a table never resolves as a collection (names
		// are unique across kinds), and auto-create must not squat on it.
		if (row && row.kind !== 'collection') return null;
		if (!row) {
			if (!options.autoCreate) return null;
			const denied = this.checkShardCap();
			if (denied) return null;
			[row] = await this.db
				.insert(collections)
				.values({ name, createdAt: new Date() })
				.onConflictDoNothing()
				.returning();
			if (!row) return null;
			this.writeDbEvent('collection.created');
			this.recordEvent('collection.created', `collection "${name}" created on first use`);
			await this.syncCollectionsState();
		}

		return this.buildConfig(row);
	}

	/** The table child's lazy config pull. NO auto-creation - tables are
	 * schema-first, so an unregistered name stays null and the child 404s. */
	async getTableConfig(name: string): Promise<TableConfig | null> {
		if (!collectionNameSchema.safeParse(name).success) return null;
		const [row] = await this.db
			.select()
			.from(collections)
			.where(eq(collections.name, name))
			.limit(1);
		if (!row || row.kind !== 'table') return null;
		return this.buildTableConfig(row);
	}

	/**
	 * The worker's routing lookup: is this shard replicated, and what kind is
	 * it? Cached isolate-locally for 60s at the caller; a stale answer is a
	 * latency wobble, never a correctness problem (replicas forward).
	 */
	async getShardRouting(
		name: string,
	): Promise<{ kind: 'collection' | 'table'; replication: 'off' | 'auto' } | null> {
		if (!collectionNameSchema.safeParse(name).success) return null;
		const [row] = await this.db
			.select()
			.from(collections)
			.where(eq(collections.name, name))
			.limit(1);
		if (!row) return null;
		return {
			kind: row.kind === 'table' ? 'table' : 'collection',
			replication: this.shardReplication(row),
		};
	}

	/** Debounced absolute row-count report from a table child. */
	async reportTableStats(name: string, stats: { rows: number }): Promise<void> {
		if (!collectionNameSchema.safeParse(name).success) return;
		const rows = Number.isFinite(stats.rows) && stats.rows >= 0 ? Math.floor(stats.rows) : 0;

		await this.db
			.update(collections)
			.set({ docs: rows, reportedAt: new Date() })
			.where(and(eq(collections.name, name), eq(collections.kind, 'table')));
		this.recordEvent('rows.changed', `table "${name}" now holds ${rows} rows`);
		await this.syncCollectionsState();
	}

	/** Debounced absolute-count report from a child. Best-effort by design. */
	async reportCollectionStats(name: string, stats: { docs: number }): Promise<void> {
		if (!collectionNameSchema.safeParse(name).success) return;
		const docs = Number.isFinite(stats.docs) && stats.docs >= 0 ? Math.floor(stats.docs) : 0;

		await this.db
			.update(collections)
			.set({ docs, reportedAt: new Date() })
			.where(eq(collections.name, name));
		this.recordEvent('documents.changed', `collection "${name}" now holds ${docs} documents`);
		await this.syncCollectionsState();
	}

	/**
	 * Erase the whole project. Children are destroyed FIRST, and the registry
	 * survives until every one of them confirmed - so a failed fan-out can be
	 * retried by id and still find them. Nothing may leave an orphaned
	 * Durable Object holding user data.
	 */
	async destroy(): Promise<void> {
		const rows = await this.db.select().from(collections).orderBy(asc(collections.name));
		for (const row of rows) {
			await this.destroyChild(row.kind === 'table' ? 'table' : 'collection', row.name);
		}

		await this.ctx.storage.deleteAll();
		// deleteAll leaves the Durable Object's alarm armed; an orphaned alarm
		// would wake the erased object where the SDK's handler dies reading its
		// dropped cf_agents_schedules table.
		await this.ctx.storage.deleteAlarm();
		setTimeout(() => this.ctx.abort(), 0);
	}

	// -------------------------------------------------------------------------
	// HTTP surface (operator routes are enforced by the console guard; only
	// /config is declared public in the manifest)

	async onRequest(request: Request): Promise<Response> {
		try {
			const response = await this.routeRequest(request);
			await drainUnusedBody(request);
			return response;
		} catch (error) {
			// The Agents SDK's own _tryCatch converts handler exceptions into a
			// bare 500 BEFORE Sentry's DO instrumentation (which only sees
			// uncaught errors) gets a look - capture the real stack first, then
			// let the SDK answer. A no-op without a DSN, so consumers unaffected.
			Sentry.captureException(error);
			throw error;
		}
	}

	private async routeRequest(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (!projectIdSchema.safeParse(this.name).success) {
			return Response.json({ error: 'invalid project id' }, { status: 400 });
		}
		const subPath = url.pathname.match(/\/agents\/[^/]+\/[^/]+(\/.*)?$/)?.[1] ?? '/';

		if (subPath === '/config' && request.method === 'GET') {
			return Response.json({ projectId: this.name, realtime: true });
		}

		if (subPath === '/overview' && request.method === 'GET') {
			return Response.json(await this.getOverview());
		}

		if (subPath === '/admin/query' && request.method === 'POST') {
			return this.adminQuery(request);
		}

		if (subPath === '/admin/aggregate' && request.method === 'POST') {
			return this.adminAggregate(request);
		}

		if (subPath === '/admin/settings' && request.method === 'PUT') {
			return this.updateSettings(request);
		}

		const collectionDoc = subPath.match(/^\/admin\/collections\/([^/]+)\/documents\/([^/]+)$/);
		if (collectionDoc) {
			return this.adminDocumentWrite(
				request,
				decodeURIComponent(collectionDoc[1]),
				decodeURIComponent(collectionDoc[2]),
			);
		}

		const shardAction = subPath.match(
			/^\/admin\/(collections|tables)\/([^/]+)\/(export|import|restore|restore-points|checkpoint|bookmark)$/,
		);
		if (shardAction) {
			const kind = shardAction[1] === 'tables' ? ('table' as const) : ('collection' as const);
			const name = decodeURIComponent(shardAction[2]);
			switch (shardAction[3]) {
				case 'export':
					if (request.method === 'GET') return this.adminExport(kind, name);
					break;
				case 'import':
					if (request.method === 'POST') return this.adminImport(request, kind, name);
					break;
				case 'restore':
					if (request.method === 'POST') return this.adminRestore(request, kind, name);
					break;
				case 'restore-points':
					if (request.method === 'GET') return this.adminRestorePoints(kind, name);
					break;
				case 'checkpoint':
					if (request.method === 'POST') return this.adminCheckpoint(request, kind, name);
					break;
				case 'bookmark':
					if (request.method === 'GET') return this.adminBookmarkForTime(url, kind, name);
					break;
			}
			return Response.json({ error: 'not found' }, { status: 404 });
		}

		const collection = subPath.match(/^\/admin\/collections\/([^/]+)$/);
		if (collection && request.method === 'PUT') {
			return this.configureCollection(request, decodeURIComponent(collection[1]));
		}
		if (collection && request.method === 'DELETE') {
			return this.deleteCollection(decodeURIComponent(collection[1]));
		}

		const replicationStatus = subPath.match(/^\/admin\/replication\/([^/]+)$/);
		if (replicationStatus && request.method === 'GET') {
			return this.adminReplicationStatus(decodeURIComponent(replicationStatus[1]));
		}

		const tableSql = subPath.match(/^\/admin\/tables\/([^/]+)\/sql$/);
		if (tableSql && request.method === 'POST') {
			return this.adminTableSql(request, decodeURIComponent(tableSql[1]));
		}

		const tableRow = subPath.match(/^\/admin\/tables\/([^/]+)\/rows\/([^/]+)$/);
		if (tableRow) {
			return this.adminTableRowWrite(
				request,
				decodeURIComponent(tableRow[1]),
				decodeURIComponent(tableRow[2]),
			);
		}

		const table = subPath.match(/^\/admin\/tables\/([^/]+)$/);
		if (table && request.method === 'PUT') {
			return this.configureTable(request, decodeURIComponent(table[1]));
		}
		if (table && request.method === 'DELETE') {
			return this.deleteTable(decodeURIComponent(table[1]));
		}

		return Response.json({ error: 'not found' }, { status: 404 });
	}

	async getOverview(): Promise<DbOverview> {
		return {
			projectId: this.name,
			collections: this.state.collections,
			tables: this.state.tables ?? [],
			state: this.state,
		};
	}

	/**
	 * One operator query surface for both engines (and the copilot's query
	 * tool): the body names exactly one of `collection` or `table`. Table
	 * compile refusals (unknown column, illegal dotted path) answer 400 with
	 * the compiler's message.
	 */
	private async adminQuery(request: Request): Promise<Response> {
		const body = (await request.json().catch(() => null)) as {
			collection?: unknown;
			table?: unknown;
			query?: unknown;
		} | null;
		const query = querySchema.safeParse(body?.query ?? {});
		const hasCollection = body?.collection !== undefined;
		const hasTable = body?.table !== undefined;
		if (!query.success || hasCollection === hasTable) {
			return Response.json(
				{ error: 'name exactly one of collection or table, plus a valid query' },
				{ status: 400 },
			);
		}

		if (hasTable) {
			const name = collectionNameSchema.safeParse(body?.table);
			if (!name.success) return Response.json({ error: 'invalid table name' }, { status: 400 });
			if (!(await this.tableRow(name.data))) {
				return Response.json({ error: 'no such table' }, { status: 404 });
			}
			const result = (await this.tableStub(name.data).adminQuery(query.data)) as unknown as Awaited<
				ReturnType<DbTable['adminQuery']>
			>;
			if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
			const { ok: _ok, ...payload } = result;
			return Response.json(payload);
		}

		const name = collectionNameSchema.safeParse(body?.collection);
		if (!name.success) return Response.json({ error: 'invalid collection name' }, { status: 400 });
		if (!(await this.collectionRow(name.data))) {
			return Response.json({ error: 'no such collection' }, { status: 404 });
		}
		const child = this.childStub(name.data);
		return Response.json(await child.adminQuery(query.data));
	}

	/** The collection registry row, or null for invalid/unknown/table names. */
	private async collectionRow(name: string): Promise<typeof collections.$inferSelect | null> {
		if (!collectionNameSchema.safeParse(name).success) return null;
		const [row] = await this.db
			.select()
			.from(collections)
			.where(eq(collections.name, name))
			.limit(1);
		return row && row.kind === 'collection' ? row : null;
	}

	/** The table registry row, or null for invalid/unknown/collection names. */
	private async tableRow(name: string): Promise<typeof collections.$inferSelect | null> {
		if (!collectionNameSchema.safeParse(name).success) return null;
		const [row] = await this.db
			.select()
			.from(collections)
			.where(eq(collections.name, name))
			.limit(1);
		return row && row.kind === 'table' ? row : null;
	}

	/** One operator aggregate surface for both engines (T2): the body names
	 * exactly one of `collection` or `table`, like /admin/query. */
	private async adminAggregate(request: Request): Promise<Response> {
		const body = (await request.json().catch(() => null)) as {
			collection?: unknown;
			table?: unknown;
			aggregate?: unknown;
		} | null;
		const aggregate = aggregateRequestSchema.safeParse(body?.aggregate);
		const hasCollection = body?.collection !== undefined;
		const hasTable = body?.table !== undefined;
		if (!aggregate.success || hasCollection === hasTable) {
			return Response.json(
				{ error: 'name exactly one of collection or table, plus a valid aggregate request' },
				{ status: 400 },
			);
		}

		if (hasTable) {
			const name = collectionNameSchema.safeParse(body?.table);
			if (!name.success) return Response.json({ error: 'invalid table name' }, { status: 400 });
			if (!(await this.tableRow(name.data))) {
				return Response.json({ error: 'no such table' }, { status: 404 });
			}
			const result = (await this.tableStub(name.data).adminAggregate(
				aggregate.data,
			)) as unknown as Awaited<ReturnType<DbTable['adminAggregate']>>;
			if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
			return Response.json({ results: result.results });
		}

		const name = collectionNameSchema.safeParse(body?.collection);
		if (!name.success) return Response.json({ error: 'invalid collection name' }, { status: 400 });
		if (!(await this.collectionRow(name.data))) {
			return Response.json({ error: 'no such collection' }, { status: 404 });
		}
		return Response.json(await this.childStub(name.data).adminAggregate(aggregate.data));
	}

	/** Operator SQL over one table - the dashboard console and the copilot's
	 * read tool ride this; the statement gate is the same table-sql.ts. */
	private async adminTableSql(request: Request, name: string): Promise<Response> {
		if (!(await this.tableRow(name))) {
			return Response.json({ error: 'no such table' }, { status: 404 });
		}
		const body = await request.json().catch(() => null);
		const result = (await this.tableStub(name).adminSql(body)) as unknown as Awaited<
			ReturnType<DbTable['adminSql']>
		>;
		if (!result.ok) return Response.json({ success: false, error: result.error }, { status: 400 });
		return Response.json({ success: true, batch: result.batch });
	}

	/**
	 * The kind adapter behind the shared admin actions. The exportChunk casts
	 * mirror the DurableObjectNamespace<any> gotcha: DbDocument carries
	 * Record<string, unknown>, and `unknown` fails the stub's Rpc.Serializable
	 * transform, collapsing the return type to never. The values are plain
	 * JSON objects; only the type system objects.
	 */
	private shardOps(kind: 'collection' | 'table', name: string): ShardAdminOps {
		if (kind === 'table') {
			const stub = () => this.tableStub(name);
			return {
				kind,
				row: () => this.tableRow(name),
				notFound: () => Response.json({ error: 'no such table' }, { status: 404 }),
				exportChunk: async (afterId?: string) =>
					(await stub().exportChunk(afterId)) as unknown as Awaited<
						ReturnType<DbTable['exportChunk']>
					>,
				importChunk: (lines: ImportLine[]) => stub().importRows(lines),
				currentBookmark: () => stub().currentBookmark(),
				bookmarkForTime: (iso: string) => stub().bookmarkForTime(iso),
				restoreTo: (body: RestoreRequest) => stub().restoreTo(body),
				reconcileCount: async () =>
					this.reportTableStats(name, { rows: await stub().getRowCount() }),
				pushShardConfig: (row) => this.pushTableConfig(row),
			};
		}
		const stub = () => this.childStub(name);
		return {
			kind,
			row: () => this.collectionRow(name),
			notFound: () => Response.json({ error: 'no such collection' }, { status: 404 }),
			exportChunk: async (afterId?: string) =>
				(await stub().exportChunk(afterId)) as unknown as Awaited<
					ReturnType<DbCollection['exportChunk']>
				>,
			importChunk: (lines: ImportLine[]) => stub().importDocs(lines),
			currentBookmark: () => stub().currentBookmark(),
			bookmarkForTime: (iso: string) => stub().bookmarkForTime(iso),
			restoreTo: (body: RestoreRequest) => stub().restoreTo(body),
			reconcileCount: async () =>
				this.reportCollectionStats(name, { docs: await stub().getDocCount() }),
			pushShardConfig: (row) => this.pushConfig(row),
		};
	}

	/** Operator NDJSON export, streamed chunk by chunk over child RPC. */
	private async adminExport(kind: 'collection' | 'table', name: string): Promise<Response> {
		const ops = this.shardOps(kind, name);
		if (!(await ops.row())) return ops.notFound();
		const encoder = new TextEncoder();
		let afterId: string | undefined;
		let done = false;

		const stream = new ReadableStream<Uint8Array>({
			async pull(controller) {
				if (done) return;
				const chunk = await ops.exportChunk(afterId);
				for (const doc of chunk.docs) {
					controller.enqueue(encoder.encode(`${JSON.stringify(doc)}\n`));
				}
				if (chunk.nextAfterId === null) {
					done = true;
					controller.close();
				} else {
					afterId = chunk.nextAfterId;
				}
			},
		});

		return new Response(stream, {
			headers: {
				'content-type': 'application/x-ndjson',
				'content-disposition': `attachment; filename="${name}.ndjson"`,
			},
		});
	}

	/** Persist a named PITR bookmark for the dashboard's restore-point list. */
	private async saveRestorePoint(
		name: string,
		bookmark: string,
		reason: string,
	): Promise<RestorePoint> {
		const capturedAt = new Date();
		await this.db.insert(restorePoints).values({ collection: name, bookmark, reason, capturedAt });
		// Marker-list cap only - restore-by-timestamp reaches any moment in the
		// 30-day window regardless of what is listed here.
		const rows = await this.db
			.select()
			.from(restorePoints)
			.where(eq(restorePoints.collection, name))
			.orderBy(desc(restorePoints.capturedAt), desc(restorePoints.id));
		for (const stale of rows.slice(MAX_RESTORE_POINTS)) {
			await this.db.delete(restorePoints).where(eq(restorePoints.id, stale.id));
		}
		return { bookmark, reason, capturedAt: capturedAt.toISOString() };
	}

	/** Capture the shard's current-moment bookmark; null when the environment
	 * has no PITR (local dev) - callers degrade gracefully. */
	private async captureRestorePoint(
		ops: ShardAdminOps,
		name: string,
		reason: string,
	): Promise<RestorePoint | null> {
		try {
			const current = await this.probeBookmark(ops);
			if (!current.ok) return null;
			return await this.saveRestorePoint(name, current.bookmark, reason);
		} catch {
			return null;
		}
	}

	/**
	 * The child's current bookmark, retried once on an abort-reset: a restore
	 * leaves that instance resetting for a tick, and without the retry a
	 * capture or a support probe in that window reports "unsupported" for a
	 * shard whose PITR is perfectly fine. The async wrapper is also what
	 * collapses the RPC stub's union return type for inference.
	 */
	private async probeBookmark(ops: ShardAdminOps) {
		const probe = async () => ops.currentBookmark();
		try {
			return await probe();
		} catch (error) {
			if (!isDurableObjectReset(error)) throw error;
			return await probe();
		}
	}

	/**
	 * The dashboard's restore-point list: named markers plus whether this
	 * environment supports PITR at all, so the dialog can explain up front
	 * instead of failing after a submit.
	 */
	private async adminRestorePoints(kind: 'collection' | 'table', name: string): Promise<Response> {
		const ops = this.shardOps(kind, name);
		if (!(await ops.row())) return ops.notFound();
		const probe = await this.probeBookmark(ops);
		// The platform window is 30 days; older markers are dead weight.
		await this.db
			.delete(restorePoints)
			.where(
				and(
					eq(restorePoints.collection, name),
					lt(restorePoints.capturedAt, new Date(Date.now() - 30 * 24 * 3600 * 1000)),
				),
			);
		const rows = await this.db
			.select()
			.from(restorePoints)
			.where(eq(restorePoints.collection, name))
			.orderBy(desc(restorePoints.capturedAt), desc(restorePoints.id));
		return Response.json({
			supported: probe.ok,
			points: rows.map((row) => ({
				bookmark: row.bookmark,
				reason: row.reason,
				capturedAt: row.capturedAt.toISOString(),
			})),
		});
	}

	/**
	 * D1-restore-style: `?at=<ISO time>` in, the closest available bookmark
	 * out - the dialog shows it BEFORE the operator commits to a restore.
	 */
	private async adminBookmarkForTime(
		url: URL,
		kind: 'collection' | 'table',
		name: string,
	): Promise<Response> {
		const at = url.searchParams.get('at') ?? '';
		const target = new Date(at).getTime();
		const now = Date.now();
		if (!at || Number.isNaN(target) || target > now || now - target > 30 * 24 * 3600 * 1000) {
			return Response.json(
				{ error: 'pass ?at=<ISO timestamp> within the past 30 days' },
				{ status: 400 },
			);
		}
		const ops = this.shardOps(kind, name);
		if (!(await ops.row())) return ops.notFound();

		const resolve = async () => ops.bookmarkForTime(new Date(target).toISOString());
		let outcome;
		try {
			outcome = await resolve();
		} catch (error) {
			// Same reset window as probeBookmark: retry once on the fresh instance.
			if (!isDurableObjectReset(error)) throw error;
			outcome = await resolve();
		}
		if (!outcome.ok) {
			if (outcome.code === 'unsupported') {
				return Response.json(
					{
						error:
							'point-in-time recovery is not available in this environment - ' +
							'local development keeps no durable change log',
					},
					{ status: 501 },
				);
			}
			return Response.json({ error: outcome.message ?? 'bookmark lookup failed' }, { status: 400 });
		}
		return Response.json({ bookmark: outcome.bookmark, at: new Date(target).toISOString() });
	}

	/** Manual checkpoint: capture "now" as a named restore point. */
	private async adminCheckpoint(
		request: Request,
		kind: 'collection' | 'table',
		name: string,
	): Promise<Response> {
		const body = checkpointRequestSchema.safeParse(await request.json().catch(() => ({})));
		if (!body.success) {
			return Response.json(
				{ error: 'invalid checkpoint request', issues: body.error.issues },
				{ status: 400 },
			);
		}
		const ops = this.shardOps(kind, name);
		if (!(await ops.row())) return ops.notFound();
		const point = await this.captureRestorePoint(
			ops,
			name,
			body.data.reason ?? 'manual checkpoint',
		);
		if (!point) {
			return Response.json(
				{
					error:
						'point-in-time recovery is not available in this environment - ' +
						'local development keeps no durable change log',
				},
				{ status: 501 },
			);
		}
		return Response.json(point);
	}

	/**
	 * Operator NDJSON import: parse every line up front (bad lines are
	 * reported with their 1-based line number, good ones still land), then
	 * feed the children in RPC-sized chunks and merge their reports.
	 */
	private async adminImport(
		request: Request,
		kind: 'collection' | 'table',
		name: string,
	): Promise<Response> {
		const ops = this.shardOps(kind, name);
		if (!(await ops.row())) return ops.notFound();
		const text = await request.text().catch(() => '');
		if (new TextEncoder().encode(text).byteLength > MAX_IMPORT_BYTES) {
			return Response.json(
				{ error: `imports are limited to ${MAX_IMPORT_BYTES} bytes per request` },
				{ status: 413 },
			);
		}

		const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
		if (lines.length === 0) {
			return Response.json({ error: 'the import body carried no NDJSON lines' }, { status: 400 });
		}
		if (lines.length > MAX_IMPORT_DOCS) {
			return Response.json(
				{ error: `imports are limited to ${MAX_IMPORT_DOCS} documents per request` },
				{ status: 400 },
			);
		}

		// A free undo for the whole import (deployed stacks; local has no PITR).
		await this.captureRestorePoint(ops, name, 'before import');

		const report: ImportReport = { imported: 0, updated: 0, errors: [] };
		const valid: { line: number; parsed: ImportLine }[] = [];
		for (const [index, line] of lines.entries()) {
			let json: unknown;
			try {
				json = JSON.parse(line);
			} catch {
				report.errors.push({ line: index + 1, error: 'not valid JSON' });
				continue;
			}
			const parsed = importLineSchema.safeParse(json);
			if (!parsed.success) {
				report.errors.push({ line: index + 1, error: 'not an importable document line' });
				continue;
			}
			valid.push({ line: index + 1, parsed: parsed.data });
		}

		for (let start = 0; start < valid.length; start += IMPORT_RPC_CHUNK) {
			const chunk = valid.slice(start, start + IMPORT_RPC_CHUNK);
			const chunkReport = await ops.importChunk(chunk.map((entry) => entry.parsed));
			report.imported += chunkReport.imported;
			report.updated += chunkReport.updated;
			for (const error of chunkReport.errors) {
				report.errors.push({ line: chunk[error.line]?.line ?? -1, error: error.error });
			}
		}

		const noun = kind === 'table' ? 'rows' : 'documents';
		const importedEvent =
			kind === 'table' ? ('rows.imported' as const) : ('documents.imported' as const);
		this.writeDbEvent(importedEvent);
		this.recordEvent(
			importedEvent,
			`imported ${report.imported + report.updated} ${noun} into "${name}"` +
				(report.errors.length ? ` (${report.errors.length} lines failed)` : ''),
		);
		// Immediate count reconcile so the dashboard reflects the import now
		// rather than after the next organic write.
		try {
			await ops.reconcileCount();
		} catch {
			// best-effort: the count self-heals on the next write
		}
		return Response.json(report);
	}

	/**
	 * Point-in-time rollback of ONE shard (either kind). The child validates
	 * support and performs the platform restore; this route owns the 30-day
	 * window check and the operator-facing error shapes (501 = the environment
	 * has no durable change log, i.e. local development).
	 */
	private async adminRestore(
		request: Request,
		kind: 'collection' | 'table',
		name: string,
	): Promise<Response> {
		const parsed = restoreRequestSchema.safeParse(await request.json().catch(() => null));
		if (!parsed.success) {
			return Response.json(
				{ error: 'invalid restore request', issues: parsed.error.issues },
				{ status: 400 },
			);
		}
		if (parsed.data.timestamp !== undefined) {
			const target = new Date(parsed.data.timestamp).getTime();
			const now = Date.now();
			if (target > now || now - target > 30 * 24 * 3600 * 1000) {
				return Response.json(
					{ error: 'restore timestamps must fall within the past 30 days' },
					{ status: 400 },
				);
			}
		}
		const ops = this.shardOps(kind, name);
		if (!(await ops.row())) return ops.notFound();

		// Capture the undo point BEFORE the restore: the child aborts a tick
		// after arming it, and in production that abort can outrace the RPC
		// reply. With the pre-restore bookmark already persisted, an
		// abort-reset error still reports success with a working undo.
		const undoPoint = await this.captureRestorePoint(ops, name, 'before rollback');
		let outcome: RestoreOutcome;
		try {
			outcome = await ops.restoreTo(parsed.data);
		} catch (error) {
			if (!isDurableObjectReset(error)) throw error;
			// An abort-reset here is ambiguous: THIS restore's abort raced its
			// reply (armed - success), or the call landed in the teardown of the
			// PREVIOUS restore (rapid undo chains) and never ran. Retry once
			// against the fresh instance - re-arming the same bookmark is
			// idempotent - and only a second race counts as armed-and-raced.
			try {
				outcome = await ops.restoreTo(parsed.data);
			} catch (retryError) {
				if (!isDurableObjectReset(retryError)) throw retryError;
				outcome = { ok: true, undoBookmark: undoPoint?.bookmark ?? '' };
			}
		}
		if (!outcome.ok) {
			if (outcome.code === 'unsupported') {
				return Response.json(
					{
						error:
							'point-in-time recovery is not available in this environment - ' +
							'local development keeps no durable change log',
					},
					{ status: 501 },
				);
			}
			return Response.json({ error: outcome.message ?? 'restore failed' }, { status: 400 });
		}

		const restoredEvent =
			kind === 'table' ? ('table.restored' as const) : ('collection.restored' as const);
		this.writeDbEvent(restoredEvent);
		this.recordEvent(
			restoredEvent,
			parsed.data.timestamp
				? `${kind} "${name}" rolled back to ${parsed.data.timestamp}`
				: `${kind} "${name}" restored to a bookmark`,
		);
		// A restore rewinds the primary's storage INCLUDING its change log, so
		// the epoch that tells replicas to discard and re-bootstrap must live
		// here, in the parent. Bump it and push the config carrying it.
		const restoredRow = await ops.row();
		if (restoredRow && this.shardReplication(restoredRow) === 'auto') {
			await this.db
				.update(collections)
				.set({ repEpoch: restoredRow.repEpoch + 1 })
				.where(eq(collections.name, name));
			const bumped = await ops.row();
			if (bumped) {
				try {
					await ops.pushShardConfig(bumped);
				} catch {
					// the child heals via lazy pull; replicas resync on next pull
				}
			}
		}
		// The undo point was captured before the restore, so it is already in
		// the list; the response carries whichever undo handle survived.
		// The child aborts a tick after answering; give the restored session a
		// moment, then reconcile the count. Best-effort - the count self-heals.
		try {
			await new Promise((resolve) => setTimeout(resolve, 250));
			await ops.reconcileCount();
		} catch {
			// the restored instance reports on its next write
		}
		return Response.json({ restored: true, undoBookmark: outcome.undoBookmark });
	}

	private async adminDocumentWrite(
		request: Request,
		name: string,
		docId: string,
	): Promise<Response> {
		if (!(await this.collectionRow(name))) {
			return Response.json({ error: 'no such collection' }, { status: 404 });
		}
		const child = this.childStub(name);

		if (request.method === 'PUT') {
			const data = (await request.json().catch(() => null)) as { data?: unknown } | null;
			if (!data || typeof data.data !== 'object' || data.data === null) {
				return Response.json({ error: 'invalid document body' }, { status: 400 });
			}
			// ?ifAbsent=1: the dashboard's ADD flow refuses taken ids with 409;
			// a plain PUT keeps the editor's deliberate replace semantics. The
			// cast mirrors adminExport: DbDocument in an RPC return collapses
			// the stub's type to never.
			const ifAbsent = new URL(request.url).searchParams.get('ifAbsent') === '1';
			const result = (await child.adminPut(docId, data.data, ifAbsent)) as unknown as Awaited<
				ReturnType<DbCollection['adminPut']>
			>;
			if (typeof result === 'object' && result !== null && 'conflict' in result) {
				return Response.json({ error: 'a document with that id already exists' }, { status: 409 });
			}
			return Response.json(result);
		}
		if (request.method === 'DELETE') {
			const deleted = await child.adminDelete(docId);
			if (!deleted) return Response.json({ error: 'no such document' }, { status: 404 });
			return Response.json({ deleted: true });
		}
		return Response.json({ error: 'not found' }, { status: 404 });
	}

	private async configureCollection(request: Request, name: string): Promise<Response> {
		if (!collectionNameSchema.safeParse(name).success) {
			return Response.json(
				{ error: 'collection names are lowercase letters, digits, _ and - (max 64 chars)' },
				{ status: 400 },
			);
		}
		const modes = collectionModesSchema.safeParse(await request.json().catch(() => ({})));
		if (!modes.success) {
			return Response.json(
				{ error: 'invalid access modes', issues: modes.error.issues },
				{ status: 400 },
			);
		}

		const [existing] = await this.db
			.select()
			.from(collections)
			.where(eq(collections.name, name))
			.limit(1);

		// Names are unique across kinds (the registry PK): a table already
		// holds this one.
		if (existing && existing.kind !== 'collection') {
			return Response.json({ error: `"${name}" is already a table` }, { status: 409 });
		}
		if (!existing) {
			const denied = this.checkShardCap();
			if (denied) return denied;
		}

		// Omitted permission/validator fields stay as they are - a modes-only
		// save from the Access tab can never clobber rules configured earlier.
		const patch: Partial<typeof collections.$inferInsert> = {
			readAccess: modes.data.readAccess,
			writeAccess: modes.data.writeAccess,
		};
		if (modes.data.readPermission !== undefined) patch.readPermission = modes.data.readPermission;
		if (modes.data.writePermission !== undefined) {
			patch.writePermission = modes.data.writePermission;
		}
		if (modes.data.validator !== undefined) {
			patch.validator = modes.data.validator === null ? null : JSON.stringify(modes.data.validator);
		}
		if (modes.data.replication !== undefined) {
			patch.replication = modes.data.replication;
		}

		const [row] = await this.db
			.insert(collections)
			.values({
				name,
				readPermission: null,
				writePermission: null,
				validator: null,
				...patch,
				createdAt: new Date(),
			})
			.onConflictDoUpdate({ target: collections.name, set: patch })
			.returning();

		// Row first, THEN push: if the push fails the child heals via lazy pull.
		await this.pushConfig(row);

		this.writeDbEvent(existing ? 'collection.configured' : 'collection.created');
		this.recordEvent(
			existing ? 'collection.configured' : 'collection.created',
			existing
				? `collection "${name}" set to read=${modes.data.readAccess} write=${modes.data.writeAccess}`
				: `collection "${name}" created (read=${modes.data.readAccess} write=${modes.data.writeAccess})`,
		);
		await this.syncCollectionsState();
		return Response.json({
			name,
			readAccess: row.readAccess,
			writeAccess: row.writeAccess,
			readPermission: row.readPermission,
			writePermission: row.writePermission,
			validator: parseStoredValidator(row.validator),
		});
	}

	private async deleteCollection(name: string): Promise<Response> {
		const row = await this.collectionRow(name);
		if (!row) return Response.json({ error: 'no such collection' }, { status: 404 });

		// Child first, registry second - a failure leaves the row so the
		// operator can retry; the reverse order would orphan the child's data.
		await this.destroyChild('collection', name);
		await this.db.delete(collections).where(eq(collections.name, name));
		// A deliberate erase must stay erased - drop its restore markers too.
		await this.db.delete(restorePoints).where(eq(restorePoints.collection, name));

		this.writeDbEvent('collection.deleted');
		this.recordEvent('collection.deleted', `collection "${name}" deleted`);
		await this.syncCollectionsState();
		return Response.json({ deleted: true });
	}

	/**
	 * Declare or alter a table: full desired schema in, destructive diffs
	 * refused HERE (before any row write or push - the child's planner is
	 * defensive only), row first, then push. A DDL failure at the child (e.g.
	 * uniquifying a column holding duplicates) must not leave the registry
	 * claiming columns that never applied: the row reverts and the SQLite
	 * message surfaces as the 409.
	 */
	private async configureTable(request: Request, name: string): Promise<Response> {
		if (!collectionNameSchema.safeParse(name).success) {
			return Response.json(
				{ error: 'table names are lowercase letters, digits, _ and - (max 64 chars)' },
				{ status: 400 },
			);
		}
		const modes = tableModesSchema.safeParse(await request.json().catch(() => ({})));
		if (!modes.success) {
			return Response.json(
				{ error: 'invalid table schema', issues: modes.error.issues },
				{ status: 400 },
			);
		}

		const [existing] = await this.db
			.select()
			.from(collections)
			.where(eq(collections.name, name))
			.limit(1);
		if (existing && existing.kind !== 'table') {
			return Response.json({ error: `"${name}" is already a collection` }, { status: 409 });
		}
		if (!existing) {
			const denied = this.checkShardCap();
			if (denied) return denied;
		}

		if (existing) {
			const plan = planDdl(name, parseStoredColumns(existing.columns), modes.data.columns);
			if (!plan.ok) return Response.json({ error: plan.reason }, { status: 400 });
		}

		const patch: Partial<typeof collections.$inferInsert> = {
			readAccess: modes.data.readAccess,
			writeAccess: modes.data.writeAccess,
			columns: JSON.stringify(modes.data.columns),
		};
		if (modes.data.readPermission !== undefined) patch.readPermission = modes.data.readPermission;
		if (modes.data.writePermission !== undefined) {
			patch.writePermission = modes.data.writePermission;
		}
		if (modes.data.replication !== undefined) {
			patch.replication = modes.data.replication;
		}

		const [row] = await this.db
			.insert(collections)
			.values({
				name,
				kind: 'table',
				readPermission: null,
				writePermission: null,
				validator: null,
				...patch,
				createdAt: new Date(),
			})
			.onConflictDoUpdate({ target: collections.name, set: patch })
			.returning();

		try {
			await this.pushTableConfig(row);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (existing) {
				await this.db
					.update(collections)
					.set({
						readAccess: existing.readAccess,
						writeAccess: existing.writeAccess,
						readPermission: existing.readPermission,
						writePermission: existing.writePermission,
						columns: existing.columns,
					})
					.where(eq(collections.name, name));
			} else {
				await this.db.delete(collections).where(eq(collections.name, name));
			}
			return Response.json(
				{ error: `schema change failed: ${message.slice(0, 256)}` },
				{ status: 409 },
			);
		}

		this.writeDbEvent(existing ? 'table.configured' : 'table.created');
		this.recordEvent(
			existing ? 'table.configured' : 'table.created',
			existing
				? `table "${name}" reconfigured (${modes.data.columns.length} columns)`
				: `table "${name}" declared (${modes.data.columns.length} columns)`,
		);
		await this.syncCollectionsState();
		return Response.json({
			name,
			readAccess: row.readAccess,
			writeAccess: row.writeAccess,
			readPermission: row.readPermission,
			writePermission: row.writePermission,
			columns: parseStoredColumns(row.columns),
		});
	}

	private async deleteTable(name: string): Promise<Response> {
		const row = await this.tableRow(name);
		if (!row) return Response.json({ error: 'no such table' }, { status: 404 });

		// Child first, registry second - the collection erase discipline.
		await this.destroyChild('table', name);
		await this.db.delete(collections).where(eq(collections.name, name));
		// A deliberate erase must stay erased - drop its restore markers too.
		await this.db.delete(restorePoints).where(eq(restorePoints.collection, name));

		this.writeDbEvent('table.deleted');
		this.recordEvent('table.deleted', `table "${name}" deleted`);
		await this.syncCollectionsState();
		return Response.json({ deleted: true });
	}

	/** The replica map: lag and last-seen per region, for either kind. */
	private async adminReplicationStatus(name: string): Promise<Response> {
		const routing = await this.getShardRouting(name);
		if (!routing) return Response.json({ error: 'no such collection or table' }, { status: 404 });
		const status =
			routing.kind === 'table'
				? await this.tableStub(name).repStatus()
				: await this.childStub(name).repStatus();
		return Response.json(status);
	}

	private async adminTableRowWrite(
		request: Request,
		name: string,
		rowId: string,
	): Promise<Response> {
		if (!(await this.tableRow(name))) {
			return Response.json({ error: 'no such table' }, { status: 404 });
		}
		const child = this.tableStub(name);

		if (request.method === 'PUT') {
			const data = (await request.json().catch(() => null)) as { data?: unknown } | null;
			if (!data || typeof data.data !== 'object' || data.data === null) {
				return Response.json({ error: 'invalid row body' }, { status: 400 });
			}
			const ifAbsent = new URL(request.url).searchParams.get('ifAbsent') === '1';
			let result: Awaited<ReturnType<DbTable['adminPut']>>;
			try {
				result = (await child.adminPut(rowId, data.data, ifAbsent)) as unknown as Awaited<
					ReturnType<DbTable['adminPut']>
				>;
			} catch (error) {
				const column = uniqueViolationColumn(error);
				if (!column) throw error;
				return Response.json(
					{ error: `a row with that ${column} already exists (unique column)` },
					{ status: 409 },
				);
			}
			if (typeof result === 'object' && result !== null && 'conflict' in result) {
				return Response.json({ error: 'a row with that id already exists' }, { status: 409 });
			}
			if (typeof result === 'object' && result !== null && 'invalid' in result) {
				return Response.json(
					{ error: 'row failed validation', issues: result.invalid },
					{ status: 400 },
				);
			}
			return Response.json(result);
		}
		if (request.method === 'DELETE') {
			const deleted = await child.adminDelete(rowId);
			if (!deleted) return Response.json({ error: 'no such row' }, { status: 404 });
			return Response.json({ deleted: true });
		}
		return Response.json({ error: 'not found' }, { status: 404 });
	}

	private async updateSettings(request: Request): Promise<Response> {
		const parsed = settingsRequestSchema.safeParse(await request.json().catch(() => null));
		if (!parsed.success) {
			return Response.json(
				{ error: 'invalid settings', issues: parsed.error.issues },
				{ status: 400 },
			);
		}

		this.setState({ ...this.state, allowedOrigins: parsed.data.allowedOrigins });

		// Re-push every child - both kinds - so cached CORS lists update.
		// Retry once; a child that still fails heals on its next lazy pull.
		const rows = await this.db.select().from(collections);
		for (const row of rows) {
			const push =
				row.kind === 'table' ? () => this.pushTableConfig(row) : () => this.pushConfig(row);
			try {
				await push();
			} catch {
				try {
					await push();
				} catch {
					// seconds-level staleness accepted; documented risk
				}
			}
		}
		return Response.json({ allowedOrigins: parsed.data.allowedOrigins });
	}

	// -------------------------------------------------------------------------
	// Children, config push, state sync

	private childStub(name: string) {
		const namespace = this.env.DbCollection as unknown as DurableObjectNamespace<DbCollection>;
		return namespace.get(namespace.idFromName(`${this.name}:${name}`));
	}

	private tableStub(name: string) {
		const namespace = this.env.DbTable as unknown as DurableObjectNamespace<DbTable>;
		return namespace.get(namespace.idFromName(`${this.name}:${name}`));
	}

	/**
	 * Destroy one child of either kind, tolerating the abort-vs-reply race:
	 * an abort-reset error is verified against a fresh instance instead of
	 * failing the operation - zero documents/rows means the wipe landed. A
	 * genuine failure rethrows, and the registry row survives so the operator
	 * can retry; nothing may orphan a Durable Object holding data.
	 */
	private async destroyChild(kind: 'collection' | 'table', name: string): Promise<void> {
		try {
			if (kind === 'table') await this.tableStub(name).destroy();
			else await this.childStub(name).destroy();
		} catch (error) {
			if (!isDurableObjectReset(error)) throw error;
			const remaining =
				kind === 'table'
					? await this.tableStub(name).getRowCount()
					: await this.childStub(name).getDocCount();
			if (remaining > 0) throw error;
		}
	}

	private async buildConfig(row: typeof collections.$inferSelect): Promise<CollectionConfig> {
		const version = ((await this.ctx.storage.get<number>('config-version')) ?? 0) + 1;
		await this.ctx.storage.put('config-version', version);
		return {
			projectId: this.name,
			collection: row.name,
			readAccess: row.readAccess as AccessMode,
			writeAccess: row.writeAccess as AccessMode,
			readPermission: row.readPermission,
			writePermission: row.writePermission,
			validator: parseStoredValidator(row.validator),
			allowedOrigins: this.state.allowedOrigins,
			demo: this.isEphemeral,
			configVersion: version,
			replication: this.shardReplication(row),
			repEpoch: row.repEpoch,
		};
	}

	private async pushConfig(row: typeof collections.$inferSelect): Promise<void> {
		const child = this.childStub(row.name);
		await child.configure(await this.buildConfig(row));
	}

	private async buildTableConfig(row: typeof collections.$inferSelect): Promise<TableConfig> {
		const version = ((await this.ctx.storage.get<number>('config-version')) ?? 0) + 1;
		await this.ctx.storage.put('config-version', version);
		return {
			kind: 'table',
			projectId: this.name,
			table: row.name,
			readAccess: row.readAccess as AccessMode,
			writeAccess: row.writeAccess as AccessMode,
			readPermission: row.readPermission,
			writePermission: row.writePermission,
			columns: parseStoredColumns(row.columns),
			allowedOrigins: this.state.allowedOrigins,
			demo: this.isEphemeral,
			configVersion: version,
			replication: this.shardReplication(row),
			repEpoch: row.repEpoch,
		};
	}

	private async pushTableConfig(row: typeof collections.$inferSelect): Promise<void> {
		await this.tableStub(row.name).configure(await this.buildTableConfig(row));
	}

	/** ONE pool across kinds: a project holds at most MAX_COLLECTIONS shards
	 * (collections + tables together), DEMO_MAX_COLLECTIONS in demos. */
	private checkShardCap(): Response | null {
		const cap = this.isEphemeral ? DEMO_MAX_COLLECTIONS : MAX_COLLECTIONS;
		const total = this.state.collections.length + (this.state.tables ?? []).length;
		if (total >= cap) {
			return Response.json(
				{
					error: this.isEphemeral
						? `demo projects are capped at ${DEMO_MAX_COLLECTIONS} collections and tables`
						: `projects are capped at ${MAX_COLLECTIONS} collections and tables`,
				},
				{ status: 429 },
			);
		}
		return null;
	}

	private async syncCollectionsState(): Promise<void> {
		const rows = await this.db.select().from(collections).orderBy(asc(collections.name));
		const summaries: DbCollectionSummary[] = rows
			.filter((row) => row.kind === 'collection')
			.map((row) => ({
				name: row.name,
				readAccess: row.readAccess as AccessMode,
				writeAccess: row.writeAccess as AccessMode,
				readPermission: row.readPermission,
				writePermission: row.writePermission,
				validator: parseStoredValidator(row.validator),
				replication: this.shardReplication(row),
				docs: row.docs,
			}));
		const tables: DbTableSummary[] = rows
			.filter((row) => row.kind === 'table')
			.map((row) => ({
				name: row.name,
				readAccess: row.readAccess as AccessMode,
				writeAccess: row.writeAccess as AccessMode,
				readPermission: row.readPermission,
				writePermission: row.writePermission,
				columns: parseStoredColumns(row.columns),
				replication: this.shardReplication(row),
				rows: row.docs,
			}));
		this.setState({
			...this.state,
			collections: summaries,
			tables,
			totalDocs: summaries.reduce((sum, entry) => sum + entry.docs, 0),
			totalRows: tables.reduce((sum, entry) => sum + entry.rows, 0),
			rev: this.state.rev + 1,
		});
	}

	private recordEvent(type: DbActivityEvent['type'], message: string): void {
		const at = new Date().toISOString();
		const event: DbActivityEvent = { id: crypto.randomUUID(), type, message, at };
		this.setState({
			...this.state,
			events: [event, ...this.state.events].slice(0, MAX_EVENTS),
			totalEvents: this.state.totalEvents + 1,
			lastEventAt: at,
		});
	}

	/** Best-effort analytics; a metrics failure never fails the operation. */
	private writeDbEvent(eventType: string): void {
		try {
			this.env.DB_EVENTS?.writeDataPoint({
				indexes: [this.name],
				// Schema: event, collection, country, subject, reserved.
				blobs: [eventType, 'none', 'unknown', 'none', 'none'],
				doubles: [1],
			});
		} catch {
			// never let metrics break the operation
		}
		if (this.env.LOCAL_ANALYTICS) {
			this.ctx.waitUntil(
				this.env.LOCAL_ANALYTICS.prepare(
					`INSERT INTO db_events (project_id, event_type, collection, timestamp) VALUES (?, ?, ?, ?)`,
				)
					.bind(this.name, eventType, 'none', Date.now())
					.run()
					.then(() => undefined)
					.catch(() => undefined),
			);
		}
	}
}
