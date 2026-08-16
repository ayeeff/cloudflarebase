import * as Sentry from '@sentry/cloudflare';
import { Agent, type AgentContext } from 'agents';
import { asc, count, eq } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { drainUnusedBody } from './access';
import * as schema from './db/schema';
import { buckets, type BucketRecord } from './db/schema';
import { r2BucketPrefix, r2ProjectPrefix } from './keys';
import migrations from './migrations';
import {
	DEMO_PROJECT_PATTERN,
	bucketConfigInputSchema,
	bucketNameSchema,
	projectIdSchema,
	type BucketConfig,
	type BucketConfigInput,
} from './schemas';
import type { BucketStats, StorageBucket } from './bucket';

/**
 * StorageAgent - one Durable Object per project: the bucket registry and
 * access config, project totals, state sync for the dashboard, and the erase
 * drain. Control plane, not data plane: bytes live in R2 and stream through
 * the WORKER (src/index.ts), which never enters this object with a body.
 *
 * The worker enforces per-bucket access from `getBucketAccess`, cached per
 * isolate for a short TTL - so the parent is consulted about once per
 * 30 seconds per bucket per isolate, never per request. Quota answers ride
 * the same call: the child indexes report debounced absolute counters here,
 * and the fold into `getBucketAccess` is how single-shot writes enforce the
 * project ceiling without a per-request parent hop. Enforcement is therefore
 * EVENTUAL (bounded by the debounce window plus the cache TTL) - the same
 * bargain the db agent's counters make.
 */

/** Hard v1 caps, env-overridable; plan lookups arrive in Phase C. */
const MAX_BUCKETS_PER_PROJECT = 5;
const MAX_OBJECTS_PER_BUCKET = 10_000;
const MAX_PROJECT_BYTES = 1024 * 1024 * 1024; // 1 GB - R2's free tier is 10
/** Cycles of list(1000)+delete(1000) per drain wake, bounding wall time. */
const DRAIN_CYCLES_PER_WAKE = 5;
const DRAIN_RETRY_SECONDS = 30;

const DO_RESET_PATTERN = /abort\(\) to reset|durable object reset/i;
function isDurableObjectReset(error: unknown): boolean {
	return DO_RESET_PATTERN.test(error instanceof Error ? error.message : String(error));
}

function envInt(env: Env, name: string, fallback: number): number {
	const raw = (env as unknown as Record<string, string | undefined>)[name];
	const parsed = Number.parseInt(raw ?? '', 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export interface StorageBucketSummary {
	name: string;
	read: 'public' | 'auth' | 'owner';
	write: 'public' | 'auth' | 'owner';
	publicListing: boolean;
	objectCount: number;
	totalBytes: number;
	createdAt: string;
}

export interface StorageAgentState {
	projectId: string;
	provisionedAt: string | null;
	buckets: StorageBucketSummary[];
	totalObjects: number;
	totalBytes: number;
	/** Whether this install can actually store bytes (the R2 binding). */
	configured: boolean;
	/** Bumped on any reported change; dashboards refetch when it moves. */
	rev: number;
}

/** The worker's per-isolate cache entry - config, counters, and the quota
 * verdict in ONE answer, so the object paths pay at most one parent hop per
 * cache window. */
export type BucketAccessAnswer =
	| { status: 'missing' }
	| { status: 'erasing' }
	| {
			status: 'ok';
			config: BucketConfig;
			stats: BucketStats;
			/** Project-wide byte total across every bucket (debounced). */
			projectBytes: number;
			/** Caps the worker enforces, resolved against env overrides here so
			 * the two sides can never disagree on a ceiling. */
			maxObjects: number;
			maxProjectBytes: number;
	  };

function toConfig(row: BucketRecord): BucketConfig {
	return {
		name: row.name,
		read: row.readAccess,
		write: row.writeAccess,
		readPermission: row.readPermission,
		writePermission: row.writePermission,
		publicListing: row.publicListing,
		maxObjectBytes: row.maxObjectBytes,
		allowedContentTypes: row.allowedContentTypes ?? null,
		cacheControl: row.cacheControl,
		configVersion: row.configVersion,
	};
}

function toSummary(row: BucketRecord): StorageBucketSummary {
	return {
		name: row.name,
		read: row.readAccess,
		write: row.writeAccess,
		publicListing: row.publicListing,
		objectCount: row.objectCount,
		totalBytes: row.totalBytes,
		createdAt: row.createdAt.toISOString(),
	};
}

export class StorageAgent extends Agent<Env, StorageAgentState> {
	initialState: StorageAgentState = {
		projectId: '',
		provisionedAt: null,
		buckets: [],
		totalObjects: 0,
		totalBytes: 0,
		configured: false,
		rev: 0,
	};

	db: DrizzleSqliteDODatabase<typeof schema>;

	constructor(ctx: AgentContext, env: Env) {
		super(ctx, env);
		this.db = drizzle(ctx.storage, { schema });
	}

	async onStart(): Promise<void> {
		// Idempotent - drizzle tracks applied migrations in its own table.
		await migrate(this.db, migrations);
		if (!this.state.projectId) {
			this.setState({
				...this.state,
				projectId: this.name,
				provisionedAt: new Date().toISOString(),
				configured: Boolean(this.env.BUCKET),
			});
		}
	}

	private childStub(bucket: string): StorageBucket {
		const namespace = this.env.StorageBucket as unknown as DurableObjectNamespace;
		return namespace.get(
			namespace.idFromName(`${this.name}:${bucket}`),
		) as unknown as StorageBucket;
	}

	private async isErasing(): Promise<boolean> {
		return (await this.ctx.storage.get<boolean>('erasing')) === true;
	}

	private async syncState(): Promise<void> {
		const rows = await this.db.select().from(buckets).orderBy(asc(buckets.createdAt));
		this.setState({
			...this.state,
			projectId: this.name,
			buckets: rows.map(toSummary),
			totalObjects: rows.reduce((total, row) => total + row.objectCount, 0),
			totalBytes: rows.reduce((total, row) => total + row.totalBytes, 0),
			configured: Boolean(this.env.BUCKET),
			rev: this.state.rev + 1,
		});
	}

	// -------------------------------------------------------------------
	// RPC surface (worker + children)

	/**
	 * The worker's per-request authority, answered from the registry. One
	 * call carries config, counters, and quota verdict - the worker caches it
	 * per isolate, so a flip toward MORE restrictive access converges within
	 * that TTL rather than instantly (docs/storage-agent-plan.md, "Access
	 * control").
	 */
	async getBucketAccess(bucket: string): Promise<BucketAccessAnswer> {
		if (await this.isErasing()) return { status: 'erasing' };
		if (!bucketNameSchema.safeParse(bucket).success) return { status: 'missing' };
		const [row] = await this.db.select().from(buckets).where(eq(buckets.name, bucket)).limit(1);
		if (!row) return { status: 'missing' };
		const rows = await this.db.select().from(buckets);
		return {
			status: 'ok',
			config: toConfig(row),
			stats: { objectCount: row.objectCount, totalBytes: row.totalBytes },
			projectBytes: rows.reduce((total, other) => total + other.totalBytes, 0),
			maxObjects: envInt(this.env, 'STORAGE_MAX_OBJECTS_PER_BUCKET', MAX_OBJECTS_PER_BUCKET),
			maxProjectBytes: envInt(this.env, 'STORAGE_MAX_PROJECT_BYTES', MAX_PROJECT_BYTES),
		};
	}

	/** Child heartbeat: debounced ABSOLUTE counters (self-healing - a restore
	 * or missed report corrects itself the next time anything writes). State
	 * re-syncs only when a number actually moved. */
	async reportBucketStats(bucket: string, stats: BucketStats): Promise<void> {
		const [row] = await this.db.select().from(buckets).where(eq(buckets.name, bucket)).limit(1);
		if (!row) return;
		if (row.objectCount === stats.objectCount && row.totalBytes === stats.totalBytes) return;
		await this.db
			.update(buckets)
			.set({ objectCount: stats.objectCount, totalBytes: stats.totalBytes })
			.where(eq(buckets.name, bucket));
		await this.syncState();
	}

	/**
	 * Erase fan-in target (`DELETE /internal/projects/:id`). Wipes every
	 * bucket index, drops the registry, and schedules the R2 prefix drain -
	 * answering as soon as the metadata is gone and the drain is durably
	 * scheduled. The `erasing` flag stays set until the prefix comes back
	 * empty, refusing every object path with 503 in between: without it a
	 * re-minted project id (same DO name) would interleave with the drain -
	 * the drain deletes the new tenant's uploads, or exits early and
	 * bequeaths the old tenant's bytes to the new one.
	 */
	async destroy(): Promise<void> {
		await this.ctx.storage.put('erasing', true);
		const rows = await this.db.select().from(buckets);
		for (const row of rows) {
			try {
				await this.childStub(row.name).destroy();
			} catch (error) {
				// The child's own deferred abort can outrace the RPC reply in
				// production; its storage is already gone by then.
				if (!isDurableObjectReset(error)) throw error;
			}
		}
		await this.db.delete(buckets);
		if (this.env.BUCKET) {
			await this.schedule(1, 'drainErase');
			return;
		}
		await this.finishErase();
	}

	/**
	 * The R2 prefix drain, retried indefinitely under alarms - the failure
	 * mode of giving up is silent recurring billing for bytes nobody can
	 * reach. Self-destructs only when the prefix comes back empty.
	 */
	async drainErase(): Promise<void> {
		const bucket = this.env.BUCKET;
		if (!bucket) {
			await this.finishErase();
			return;
		}
		try {
			for (let cycle = 0; cycle < DRAIN_CYCLES_PER_WAKE; cycle++) {
				const listed = await bucket.list({ prefix: r2ProjectPrefix(this.name), limit: 1000 });
				if (listed.objects.length === 0) {
					await this.finishErase();
					return;
				}
				await bucket.delete(listed.objects.map((object) => object.key));
			}
			await this.schedule(1, 'drainErase');
		} catch (error) {
			Sentry.captureException(error, {
				tags: { operation: 'storage-erase-drain', projectId: this.name },
			});
			await this.schedule(DRAIN_RETRY_SECONDS, 'drainErase');
		}
	}

	/**
	 * Final teardown, reached from the drain's SCHEDULED CALLBACK - which is
	 * why it clears its own state explicitly instead of `deleteAll()`.
	 *
	 * `drainErase` runs inside the Agents SDK's alarm body, and that body
	 * keeps working after the callback returns: it deletes the consumed
	 * schedule row and then queries `cf_agents_schedules` again to arm the
	 * next alarm. A `deleteAll()` here drops that table out from under it, so
	 * the alarm died with an uncaught `SqlError: no such table:
	 * cf_agents_schedules` - which Cloudflare retries (each retry throwing at
	 * the same query), reports to Sentry as a failed erase, and, because the
	 * throw escapes before the output gate opens, can ROLL BACK the very
	 * deletes that ended the drain. That would leave `erasing` set forever,
	 * and the flag is what makes every object path answer 503 - so the
	 * cleanup crash would strand the next tenant of a re-minted id on exactly
	 * the failure the flag exists to prevent.
	 *
	 * So: empty the registry, clear the flag, and reset agent state (what
	 * `deleteAll()` was really buying - the SDK persists `state`, and a
	 * re-minted id must read zeroes, not the erased tenant's totals). The
	 * SDK's own tables survive intact, the alarm body finishes normally, and
	 * with no schedule rows left it arms nothing. No `ctx.abort()` either: the
	 * only in-memory state is `state`, which was just reset, and aborting
	 * mid-alarm-body is the same class of trap.
	 *
	 * Idempotent, deliberately - a retry armed by an earlier failed cycle may
	 * still fire after this runs.
	 */
	private async finishErase(): Promise<void> {
		await this.db.delete(buckets);
		await this.ctx.storage.delete('erasing');
		this.setState({
			...this.initialState,
			projectId: this.name,
			provisionedAt: new Date().toISOString(),
			configured: Boolean(this.env.BUCKET),
		});
	}

	// -------------------------------------------------------------------
	// HTTP surface (operator plane, console-guard/service-binding only)

	async onRequest(request: Request): Promise<Response> {
		try {
			const response = await this.routeRequest(request);
			await drainUnusedBody(request);
			return response;
		} catch (error) {
			// The Agents SDK's own _tryCatch converts handler exceptions into a
			// bare 500 before Sentry's DO instrumentation sees them - capture the
			// real stack first, then let the SDK answer.
			Sentry.captureException(error);
			throw error;
		}
	}

	private async routeRequest(request: Request): Promise<Response> {
		if (!projectIdSchema.safeParse(this.name).success) {
			return Response.json({ error: 'invalid project id' }, { status: 400 });
		}
		if (DEMO_PROJECT_PATTERN.test(this.name)) {
			// No demo storage in v1: anonymous object hosting is a phishing
			// machine. The synthetic read-only demo bucket is the planned
			// replacement (docs/storage-agent-plan.md, "Demo storage").
			return Response.json(
				{ error: 'storage is not available on demo projects - create a real project to use it' },
				{ status: 403 },
			);
		}
		const url = new URL(request.url);
		const subPath = url.pathname.match(/\/agents\/[^/]+\/[^/]+(\/.*)?$/)?.[1] ?? '/';

		if (subPath === '/overview' && request.method === 'GET') {
			return Response.json(await this.getOverview());
		}
		if (subPath === '/admin/buckets' && request.method === 'GET') {
			const rows = await this.db.select().from(buckets).orderBy(asc(buckets.createdAt));
			return Response.json({ buckets: rows.map(toSummary) });
		}
		const bucketRoute = subPath.match(/^\/admin\/buckets\/([^/]+)$/);
		if (bucketRoute) {
			const name = decodeURIComponent(bucketRoute[1]);
			if (!bucketNameSchema.safeParse(name).success) {
				return Response.json(
					{ error: 'bucket names are 2-63 lowercase letters, digits, and dashes' },
					{ status: 400 },
				);
			}
			if (request.method === 'GET') return this.getBucket(name);
			if (request.method === 'PUT') return this.putBucket(name, request);
			if (request.method === 'DELETE') return this.deleteBucket(name);
		}

		return Response.json({ error: 'not found' }, { status: 404 });
	}

	async getOverview(): Promise<Record<string, unknown>> {
		const rows = await this.db.select().from(buckets).orderBy(asc(buckets.createdAt));
		return {
			projectId: this.name,
			provisionedAt: this.state.provisionedAt,
			buckets: rows.map(toSummary),
			totalObjects: rows.reduce((total, row) => total + row.objectCount, 0),
			totalBytes: rows.reduce((total, row) => total + row.totalBytes, 0),
			// Honest config report, so the dashboard can explain instead of 502:
			// R2 is a dashboard checkout away, never a deploy-time requirement.
			configured: Boolean(this.env.BUCKET),
			erasing: await this.isErasing(),
			caps: {
				maxBuckets: envInt(this.env, 'STORAGE_MAX_BUCKETS', MAX_BUCKETS_PER_PROJECT),
				maxObjectsPerBucket: envInt(
					this.env,
					'STORAGE_MAX_OBJECTS_PER_BUCKET',
					MAX_OBJECTS_PER_BUCKET,
				),
				maxProjectBytes: envInt(this.env, 'STORAGE_MAX_PROJECT_BYTES', MAX_PROJECT_BYTES),
			},
		};
	}

	private async getBucket(name: string): Promise<Response> {
		const [row] = await this.db.select().from(buckets).where(eq(buckets.name, name)).limit(1);
		if (!row) return Response.json({ error: 'no such bucket' }, { status: 404 });
		return Response.json({ bucket: { ...toConfig(row), ...toSummary(row) } });
	}

	/**
	 * Create or update a bucket. Omitted fields keep their stored value and
	 * explicit null clears (db's semantics), so a modes-only save can never
	 * clobber rules configured earlier. New buckets default to `auth` on both
	 * modes - secure by default; opening one to the anonymous internet is an
	 * explicit operator act.
	 */
	private async putBucket(name: string, request: Request): Promise<Response> {
		if (await this.isErasing()) {
			return Response.json({ error: 'this project is being erased' }, { status: 503 });
		}
		const parsed = bucketConfigInputSchema.safeParse(await request.json().catch(() => null));
		if (!parsed.success) {
			return Response.json({ error: 'invalid bucket config' }, { status: 400 });
		}
		const input: BucketConfigInput = parsed.data;

		const [existing] = await this.db.select().from(buckets).where(eq(buckets.name, name)).limit(1);
		if (!existing) {
			const [{ value: bucketCount }] = await this.db.select({ value: count() }).from(buckets);
			const maxBuckets = envInt(this.env, 'STORAGE_MAX_BUCKETS', MAX_BUCKETS_PER_PROJECT);
			if (bucketCount >= maxBuckets) {
				return Response.json(
					{ error: `projects are limited to ${maxBuckets} buckets` },
					{ status: 409 },
				);
			}
			await this.db.insert(buckets).values({
				name,
				readAccess: input.read ?? 'auth',
				writeAccess: input.write ?? 'auth',
				readPermission: input.readPermission ?? null,
				writePermission: input.writePermission ?? null,
				publicListing: input.publicListing ?? false,
				maxObjectBytes: input.maxObjectBytes ?? null,
				allowedContentTypes: input.allowedContentTypes ?? null,
				cacheControl: input.cacheControl ?? null,
				configVersion: 1,
				createdAt: new Date(),
			});
			await this.syncState();
			const [created] = await this.db.select().from(buckets).where(eq(buckets.name, name)).limit(1);
			return Response.json(
				{ bucket: { ...toConfig(created), ...toSummary(created) } },
				{ status: 201 },
			);
		}

		await this.db
			.update(buckets)
			.set({
				readAccess: input.read ?? existing.readAccess,
				writeAccess: input.write ?? existing.writeAccess,
				readPermission:
					input.readPermission === undefined ? existing.readPermission : input.readPermission,
				writePermission:
					input.writePermission === undefined ? existing.writePermission : input.writePermission,
				publicListing: input.publicListing ?? existing.publicListing,
				maxObjectBytes:
					input.maxObjectBytes === undefined ? existing.maxObjectBytes : input.maxObjectBytes,
				allowedContentTypes:
					input.allowedContentTypes === undefined
						? existing.allowedContentTypes
						: input.allowedContentTypes,
				cacheControl: input.cacheControl === undefined ? existing.cacheControl : input.cacheControl,
				configVersion: existing.configVersion + 1,
			})
			.where(eq(buckets.name, name));
		await this.syncState();
		const [updated] = await this.db.select().from(buckets).where(eq(buckets.name, name)).limit(1);
		return Response.json({ bucket: { ...toConfig(updated), ...toSummary(updated) } });
	}

	/**
	 * Deletes one bucket: R2 prefix FIRST (a crash leaves benign phantom
	 * rows, never unindexed orphans), then the index instance, then the
	 * registry row - so a failure anywhere leaves the row for retry.
	 */
	private async deleteBucket(name: string): Promise<Response> {
		if (await this.isErasing()) {
			return Response.json({ error: 'this project is being erased' }, { status: 503 });
		}
		const [row] = await this.db.select().from(buckets).where(eq(buckets.name, name)).limit(1);
		if (!row) return Response.json({ error: 'no such bucket' }, { status: 404 });

		const bucket = this.env.BUCKET;
		if (bucket) {
			try {
				const prefix = r2BucketPrefix(this.name, name);
				// Bounded by the per-bucket object cap (~10k = 10 cycles).
				for (;;) {
					const listed = await bucket.list({ prefix, limit: 1000 });
					if (listed.objects.length === 0) break;
					await bucket.delete(listed.objects.map((object) => object.key));
				}
			} catch (error) {
				Sentry.captureException(error, {
					tags: { operation: 'storage-bucket-delete', projectId: this.name },
				});
				return Response.json(
					{ error: 'could not delete the bucket objects - try again' },
					{ status: 502 },
				);
			}
		}
		try {
			await this.childStub(name).destroy();
		} catch (error) {
			if (!isDurableObjectReset(error)) throw error;
		}
		await this.db.delete(buckets).where(eq(buckets.name, name));
		await this.syncState();
		return Response.json({ deleted: true });
	}
}
