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
	validatorSchema,
	DEMO_PROJECT_PATTERN,
	IMPORT_RPC_CHUNK,
	MAX_IMPORT_BYTES,
	MAX_IMPORT_DOCS,
	MAX_RESTORE_POINTS,
	type AccessMode,
	type CollectionConfig,
	type CollectionValidator,
	type ImportLine,
	type ImportReport,
	type RestorePoint,
} from './schemas';
import type { DbCollection } from './collection';

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

export interface DbActivityEvent {
	id: string;
	type:
		| 'project.provisioned'
		| 'collection.created'
		| 'collection.deleted'
		| 'collection.configured'
		| 'collection.restored'
		| 'documents.changed'
		| 'documents.imported';
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
	docs: number;
}

export interface DbAgentState {
	projectId: string;
	provisionedAt: string | null;
	allowedOrigins: string[];
	collections: DbCollectionSummary[];
	totalDocs: number;
	/** Bumped on any reported change; dashboards refetch when it moves. */
	rev: number;
	totalEvents: number;
	lastEventAt: string | null;
	events: DbActivityEvent[];
}

export interface DbOverview {
	projectId: string;
	collections: DbCollectionSummary[];
	state: DbAgentState;
}

export class DbAgent extends Agent<Env, DbAgentState> {
	initialState: DbAgentState = {
		projectId: '',
		provisionedAt: null,
		allowedOrigins: [],
		collections: [],
		totalDocs: 0,
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
		if (!row) {
			if (!options.autoCreate) return null;
			const denied = this.checkCollectionCap();
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
			await this.destroyChild(row.name);
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

		const collectionAction = subPath.match(
			/^\/admin\/collections\/([^/]+)\/(export|import|restore|restore-points|checkpoint|bookmark)$/,
		);
		if (collectionAction) {
			const name = decodeURIComponent(collectionAction[1]);
			switch (collectionAction[2]) {
				case 'export':
					if (request.method === 'GET') return this.adminExport(name);
					break;
				case 'import':
					if (request.method === 'POST') return this.adminImport(request, name);
					break;
				case 'restore':
					if (request.method === 'POST') return this.adminRestore(request, name);
					break;
				case 'restore-points':
					if (request.method === 'GET') return this.adminRestorePoints(name);
					break;
				case 'checkpoint':
					if (request.method === 'POST') return this.adminCheckpoint(request, name);
					break;
				case 'bookmark':
					if (request.method === 'GET') return this.adminBookmarkForTime(url, name);
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

		return Response.json({ error: 'not found' }, { status: 404 });
	}

	async getOverview(): Promise<DbOverview> {
		return {
			projectId: this.name,
			collections: this.state.collections,
			state: this.state,
		};
	}

	private async adminQuery(request: Request): Promise<Response> {
		const body = (await request.json().catch(() => null)) as {
			collection?: unknown;
			query?: unknown;
		} | null;
		const name = collectionNameSchema.safeParse(body?.collection);
		const query = querySchema.safeParse(body?.query ?? {});
		if (!name.success || !query.success) {
			return Response.json({ error: 'invalid collection or query' }, { status: 400 });
		}
		const [row] = await this.db
			.select()
			.from(collections)
			.where(eq(collections.name, name.data))
			.limit(1);
		if (!row) return Response.json({ error: 'no such collection' }, { status: 404 });

		const child = this.childStub(name.data);
		return Response.json(await child.adminQuery(query.data));
	}

	/** The registry row, or null for an invalid/unknown name. */
	private async collectionRow(name: string): Promise<typeof collections.$inferSelect | null> {
		if (!collectionNameSchema.safeParse(name).success) return null;
		const [row] = await this.db
			.select()
			.from(collections)
			.where(eq(collections.name, name))
			.limit(1);
		return row ?? null;
	}

	private async adminAggregate(request: Request): Promise<Response> {
		const body = (await request.json().catch(() => null)) as {
			collection?: unknown;
			aggregate?: unknown;
		} | null;
		const name = collectionNameSchema.safeParse(body?.collection);
		const aggregate = aggregateRequestSchema.safeParse(body?.aggregate);
		if (!name.success || !aggregate.success) {
			return Response.json({ error: 'invalid collection or aggregate request' }, { status: 400 });
		}
		if (!(await this.collectionRow(name.data))) {
			return Response.json({ error: 'no such collection' }, { status: 404 });
		}
		return Response.json(await this.childStub(name.data).adminAggregate(aggregate.data));
	}

	/** Operator NDJSON export, streamed chunk by chunk over child RPC. */
	private async adminExport(name: string): Promise<Response> {
		if (!(await this.collectionRow(name))) {
			return Response.json({ error: 'no such collection' }, { status: 404 });
		}
		const child = this.childStub(name);
		const encoder = new TextEncoder();
		let afterId: string | undefined;
		let done = false;

		const stream = new ReadableStream<Uint8Array>({
			async pull(controller) {
				if (done) return;
				// The cast mirrors the DurableObjectNamespace<any> gotcha: DbDocument
				// carries Record<string, unknown>, and `unknown` fails the stub's
				// Rpc.Serializable transform, collapsing the return type to never.
				// The value is a plain JSON object; only the type system objects.
				const chunk = (await child.exportChunk(afterId)) as unknown as Awaited<
					ReturnType<DbCollection['exportChunk']>
				>;
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

	/** Capture the collection's current-moment bookmark; null when the
	 * environment has no PITR (local dev) - callers degrade gracefully. */
	private async captureRestorePoint(name: string, reason: string): Promise<RestorePoint | null> {
		try {
			const current = await this.childStub(name).currentBookmark();
			if (!current.ok) return null;
			return await this.saveRestorePoint(name, current.bookmark, reason);
		} catch {
			return null;
		}
	}

	/**
	 * The dashboard's restore-point list: named markers plus whether this
	 * environment supports PITR at all, so the dialog can explain up front
	 * instead of failing after a submit.
	 */
	private async adminRestorePoints(name: string): Promise<Response> {
		if (!(await this.collectionRow(name))) {
			return Response.json({ error: 'no such collection' }, { status: 404 });
		}
		const probe = await this.childStub(name).currentBookmark();
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
	private async adminBookmarkForTime(url: URL, name: string): Promise<Response> {
		const at = url.searchParams.get('at') ?? '';
		const target = new Date(at).getTime();
		const now = Date.now();
		if (!at || Number.isNaN(target) || target > now || now - target > 30 * 24 * 3600 * 1000) {
			return Response.json(
				{ error: 'pass ?at=<ISO timestamp> within the past 30 days' },
				{ status: 400 },
			);
		}
		if (!(await this.collectionRow(name))) {
			return Response.json({ error: 'no such collection' }, { status: 404 });
		}

		const outcome = await this.childStub(name).bookmarkForTime(new Date(target).toISOString());
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
	private async adminCheckpoint(request: Request, name: string): Promise<Response> {
		const body = checkpointRequestSchema.safeParse(await request.json().catch(() => ({})));
		if (!body.success) {
			return Response.json(
				{ error: 'invalid checkpoint request', issues: body.error.issues },
				{ status: 400 },
			);
		}
		if (!(await this.collectionRow(name))) {
			return Response.json({ error: 'no such collection' }, { status: 404 });
		}
		const point = await this.captureRestorePoint(name, body.data.reason ?? 'manual checkpoint');
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
	private async adminImport(request: Request, name: string): Promise<Response> {
		if (!(await this.collectionRow(name))) {
			return Response.json({ error: 'no such collection' }, { status: 404 });
		}
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
		await this.captureRestorePoint(name, 'before import');

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

		const child = this.childStub(name);
		for (let start = 0; start < valid.length; start += IMPORT_RPC_CHUNK) {
			const chunk = valid.slice(start, start + IMPORT_RPC_CHUNK);
			const chunkReport = await child.importDocs(chunk.map((entry) => entry.parsed));
			report.imported += chunkReport.imported;
			report.updated += chunkReport.updated;
			for (const error of chunkReport.errors) {
				report.errors.push({ line: chunk[error.line]?.line ?? -1, error: error.error });
			}
		}

		this.writeDbEvent('documents.imported');
		this.recordEvent(
			'documents.imported',
			`imported ${report.imported + report.updated} documents into "${name}"` +
				(report.errors.length ? ` (${report.errors.length} lines failed)` : ''),
		);
		// Immediate count reconcile so the dashboard reflects the import now
		// rather than after the next organic write.
		try {
			await this.reportCollectionStats(name, { docs: await child.getDocCount() });
		} catch {
			// best-effort: the count self-heals on the next write
		}
		return Response.json(report);
	}

	/**
	 * Point-in-time rollback of ONE collection. The child validates support
	 * and performs the platform restore; this route owns the 30-day window
	 * check and the operator-facing error shapes (501 = the environment has
	 * no durable change log, i.e. local development).
	 */
	private async adminRestore(request: Request, name: string): Promise<Response> {
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
		if (!(await this.collectionRow(name))) {
			return Response.json({ error: 'no such collection' }, { status: 404 });
		}

		// Capture the undo point BEFORE the restore: the child aborts a tick
		// after arming it, and in production that abort can outrace the RPC
		// reply. With the pre-restore bookmark already persisted, an
		// abort-reset error still reports success with a working undo.
		const undoPoint = await this.captureRestorePoint(name, 'before rollback');
		let outcome: Awaited<ReturnType<DbCollection['restoreTo']>>;
		try {
			outcome = await this.childStub(name).restoreTo(parsed.data);
		} catch (error) {
			if (!isDurableObjectReset(error)) throw error;
			outcome = { ok: true, undoBookmark: undoPoint?.bookmark ?? '' };
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

		this.writeDbEvent('collection.restored');
		this.recordEvent(
			'collection.restored',
			parsed.data.timestamp
				? `collection "${name}" rolled back to ${parsed.data.timestamp}`
				: `collection "${name}" restored to a bookmark`,
		);
		// The undo point was captured before the restore, so it is already in
		// the list; the response carries whichever undo handle survived.
		// The child aborts a tick after answering; give the restored session a
		// moment, then reconcile the count. Best-effort - the count self-heals.
		try {
			await new Promise((resolve) => setTimeout(resolve, 250));
			await this.reportCollectionStats(name, { docs: await this.childStub(name).getDocCount() });
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
		if (!collectionNameSchema.safeParse(name).success) {
			return Response.json({ error: 'invalid collection name' }, { status: 400 });
		}
		const [row] = await this.db
			.select()
			.from(collections)
			.where(eq(collections.name, name))
			.limit(1);
		if (!row) return Response.json({ error: 'no such collection' }, { status: 404 });
		const child = this.childStub(name);

		if (request.method === 'PUT') {
			const data = (await request.json().catch(() => null)) as { data?: unknown } | null;
			if (!data || typeof data.data !== 'object' || data.data === null) {
				return Response.json({ error: 'invalid document body' }, { status: 400 });
			}
			return Response.json(await child.adminPut(docId, data.data));
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

		if (!existing) {
			const denied = this.checkCollectionCap();
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
		const [row] = await this.db
			.select()
			.from(collections)
			.where(eq(collections.name, name))
			.limit(1);
		if (!row) return Response.json({ error: 'no such collection' }, { status: 404 });

		// Child first, registry second - a failure leaves the row so the
		// operator can retry; the reverse order would orphan the child's data.
		await this.destroyChild(name);
		await this.db.delete(collections).where(eq(collections.name, name));
		// A deliberate erase must stay erased - drop its restore markers too.
		await this.db.delete(restorePoints).where(eq(restorePoints.collection, name));

		this.writeDbEvent('collection.deleted');
		this.recordEvent('collection.deleted', `collection "${name}" deleted`);
		await this.syncCollectionsState();
		return Response.json({ deleted: true });
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

		// Re-push every child so cached CORS lists update. Retry once; a child
		// that still fails heals on its next lazy pull.
		const rows = await this.db.select().from(collections);
		for (const row of rows) {
			try {
				await this.pushConfig(row);
			} catch {
				try {
					await this.pushConfig(row);
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

	/**
	 * Destroy one child, tolerating the abort-vs-reply race: an abort-reset
	 * error is verified against a fresh instance instead of failing the
	 * operation - zero documents means the wipe landed. A genuine failure
	 * (documents still there) rethrows, and the registry row survives so the
	 * operator can retry; nothing may orphan a Durable Object holding data.
	 */
	private async destroyChild(name: string): Promise<void> {
		try {
			await this.childStub(name).destroy();
		} catch (error) {
			if (!isDurableObjectReset(error)) throw error;
			const docs = await this.childStub(name).getDocCount();
			if (docs > 0) throw error;
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
		};
	}

	private async pushConfig(row: typeof collections.$inferSelect): Promise<void> {
		const child = this.childStub(row.name);
		await child.configure(await this.buildConfig(row));
	}

	private checkCollectionCap(): Response | null {
		const cap = this.isEphemeral ? DEMO_MAX_COLLECTIONS : MAX_COLLECTIONS;
		if (this.state.collections.length >= cap) {
			return Response.json(
				{
					error: this.isEphemeral
						? `demo projects are capped at ${DEMO_MAX_COLLECTIONS} collections`
						: `projects are capped at ${MAX_COLLECTIONS} collections`,
				},
				{ status: 429 },
			);
		}
		return null;
	}

	private async syncCollectionsState(): Promise<void> {
		const rows = await this.db.select().from(collections).orderBy(asc(collections.name));
		const summaries: DbCollectionSummary[] = rows.map((row) => ({
			name: row.name,
			readAccess: row.readAccess as AccessMode,
			writeAccess: row.writeAccess as AccessMode,
			readPermission: row.readPermission,
			writePermission: row.writePermission,
			validator: parseStoredValidator(row.validator),
			docs: row.docs,
		}));
		this.setState({
			...this.state,
			collections: summaries,
			totalDocs: summaries.reduce((sum, entry) => sum + entry.docs, 0),
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
