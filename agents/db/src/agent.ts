import { Agent, type AgentContext } from 'agents';
import { asc, eq } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import migrations from './migrations';
import * as schema from './db/schema';
import { collections } from './db/schema';
import {
	collectionModesSchema,
	collectionNameSchema,
	demoTtlHoursSchema,
	projectIdSchema,
	querySchema,
	settingsRequestSchema,
	DEMO_PROJECT_PATTERN,
	type AccessMode,
	type CollectionConfig,
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

export interface DbActivityEvent {
	id: string;
	type:
		| 'project.provisioned'
		| 'collection.created'
		| 'collection.deleted'
		| 'collection.configured'
		| 'documents.changed';
	message: string;
	at: string;
}

export interface DbCollectionSummary {
	name: string;
	readAccess: AccessMode;
	writeAccess: AccessMode;
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
			const child = this.childStub(row.name);
			await child.destroy();
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

		const [row] = await this.db
			.insert(collections)
			.values({
				name,
				readAccess: modes.data.readAccess,
				writeAccess: modes.data.writeAccess,
				createdAt: new Date(),
			})
			.onConflictDoUpdate({
				target: collections.name,
				set: { readAccess: modes.data.readAccess, writeAccess: modes.data.writeAccess },
			})
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
			readAccess: modes.data.readAccess,
			writeAccess: modes.data.writeAccess,
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
		const child = this.childStub(name);
		await child.destroy();
		await this.db.delete(collections).where(eq(collections.name, name));

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

	private async buildConfig(row: typeof collections.$inferSelect): Promise<CollectionConfig> {
		const version = ((await this.ctx.storage.get<number>('config-version')) ?? 0) + 1;
		await this.ctx.storage.put('config-version', version);
		return {
			projectId: this.name,
			collection: row.name,
			readAccess: row.readAccess as AccessMode,
			writeAccess: row.writeAccess as AccessMode,
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
