import * as Sentry from '@sentry/cloudflare';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { getAgentByName, routeAgentRequest } from 'agents';
import { drainUnusedBody } from './access';
import { isDurableObjectReset, DbAgent as DbAgentBase } from './agent';
import { DbCollection as DbCollectionBase } from './collection';
import { DbTable as DbTableBase } from './table';
import { regionHint, REGION_HINTS } from './region';
import { replicaName } from './replication';
import { collectionNameSchema, projectIdSchema } from './schemas';

export type {
	DbActivityEvent,
	DbAgentState,
	DbCollectionSummary,
	DbTableSummary,
	DbOverview,
} from './agent';
export type { AssertDbAgentEnv, DbAgentBindings } from './bindings';
export type {
	AccessMode,
	AggregateRequest,
	AggregateResult,
	CollectionValidator,
	ColumnType,
	DbDocument,
	DbRow,
	FieldRule,
	ImportReport,
	Query,
	RestoreRequest,
	ServerFrame,
	TableColumn,
	TableConfig,
} from './schemas';

const sentryOptions = (env: Env) => ({
	dsn: env.SENTRY_DSN,
	environment: env.SENTRY_ENV,
	tracesSampleRate: 0.1,
	enableRpcTracePropagation: true,
});

/**
 * Isolate-local replication-flag cache for read routing. A stale answer is a
 * latency wobble only: replicas forward what they should not serve, and the
 * primary serves everything - so 60 seconds of staleness cannot produce a
 * wrong result, and a non-replicated shard keeps its one-hop path with zero
 * added requests.
 */
const ROUTING_TTL_MS = 60_000;
const routingCache = new Map<string, { auto: boolean; expires: number }>();

async function shardReplicationAuto(env: Env, projectId: string, shard: string): Promise<boolean> {
	const key = `${projectId}:${shard}`;
	const cached = routingCache.get(key);
	const now = Date.now();
	if (cached && cached.expires > now) return cached.auto;
	try {
		const agent = await getAgentByName<Env, DbAgentBase>(env.DbAgent, projectId);
		const routing = await agent.getShardRouting(shard);
		const auto = routing?.replication === 'auto';
		routingCache.set(key, { auto, expires: now + ROUTING_TTL_MS });
		return auto;
	} catch {
		// The parent being unreachable must not break reads: route primary.
		routingCache.set(key, { auto: false, expires: now + ROUTING_TTL_MS });
		return false;
	}
}

/** Replicated-read detection per engine; everything else stays primary.
 * REP2 routes /subscribe (replicas run the live engine locally); T2 routes
 * /sql - the replica itself classifies and forwards DML to the primary. */
function isRoutableRead(_kind: string, method: string, subPath: string): boolean {
	if (method === 'GET') return subPath !== '/';
	if (method !== 'POST') return false;
	return subPath === '/query' || subPath === '/aggregate' || subPath === '/sql';
}

/**
 * Sibling routing for NEW subscribers: the primary knows each region
 * replica's reported socket count and answers which sibling has headroom
 * (`pickSubscribeSibling`). Cached per isolate like the replication flag -
 * a stale answer routes to a fuller (or drained) sibling, which still WORKS,
 * so this is latency-shaped state, never correctness. Plain reads always
 * stay on sibling 1: read QPS is not the ceiling being hardened, and
 * spreading them would multiply warm data copies for nothing.
 */
const SIBLING_TTL_MS = 60_000;
const siblingCache = new Map<string, { n: number; expires: number }>();

async function subscribeSibling(
	env: Env,
	kind: 'collections' | 'tables',
	projectId: string,
	shard: string,
	region: string,
): Promise<number> {
	const key = `${kind}:${projectId}:${shard}:${region}`;
	const now = Date.now();
	const cached = siblingCache.get(key);
	if (cached && cached.expires > now) return cached.n;
	const ttl = Number(env.SIBLING_ROUTING_TTL_MS ?? '') || SIBLING_TTL_MS;
	let n = 1;
	try {
		const namespace = (kind === 'tables'
			? env.DbTable
			: env.DbCollection) as unknown as DurableObjectNamespace;
		const stub = namespace.get(namespace.idFromName(`${projectId}:${shard}`)) as unknown as {
			repSubscribeTarget(region: string): Promise<number>;
		};
		const answer = await stub.repSubscribeTarget(region);
		if (Number.isInteger(answer) && answer >= 1) n = answer;
	} catch {
		// The primary being unreachable must not break subscribes: sibling 1
		// is exactly yesterday's behavior.
	}
	siblingCache.set(key, { n, expires: now + ttl });
	return n;
}

export const DbAgent = Sentry.instrumentDurableObjectWithSentry(sentryOptions, DbAgentBase);
export const DbCollection = Sentry.instrumentDurableObjectWithSentry(
	sentryOptions,
	DbCollectionBase,
);
export const DbTable = Sentry.instrumentDurableObjectWithSentry(sentryOptions, DbTableBase);

/**
 * Worker entrypoint. Routing:
 *
 * - `/health` - liveness for dev/test harnesses.
 * - `DELETE /internal/projects/:id` - erase fan-in from the console, outside
 *   /agents/* on purpose: this Worker has no public route (workers_dev and
 *   preview_urls false), so the endpoint is reachable only over the
 *   dashboard's service binding. The parent agent destroys every collection
 *   child before wiping itself.
 * - `/agents/db-agent/<pid>/collections/<c>/**` - the HOT PATH, dispatched
 *   straight to the DbCollection instance (`<pid>:<c>`) in ONE hop,
 *   including the /subscribe WebSocket upgrade.
 * - `/agents/db-agent/<pid>/tables/<t>/**` - the second hot path, same
 *   shape, straight to the DbTable instance.
 * - everything else under /agents/* - routeAgentRequest -> DbAgent
 *   (/config, /overview, /admin/*, and the AgentClient state-sync socket).
 *   Never with `cors: true`: the agents own their per-project CORS policy.
 */
class DbService extends WorkerEntrypoint<Env> {
	async fetch(request: Request): Promise<Response> {
		// Answering a body-bearing request without consuming the body wedges
		// the whole worker (uncaught "Can't read from request stream after
		// response has been sent") - every DO drains its own, and this covers
		// the entry-level answers (/health, 404s); already-forwarded bodies
		// no-op because the DO consumed the shared stream.
		const response = await this.dispatch(request);
		await drainUnusedBody(request);
		return response;
	}

	private async dispatch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/health') {
			return Response.json({ service: 'db-agent', status: 'ok' });
		}

		const erase = url.pathname.match(/^\/internal\/projects\/([^/]+)$/);
		if (erase && request.method === 'DELETE') {
			const projectId = decodeURIComponent(erase[1]);
			if (!projectIdSchema.safeParse(projectId).success) {
				return Response.json({ error: 'invalid project id' }, { status: 400 });
			}
			const agent = await getAgentByName<Env, DbAgentBase>(this.env.DbAgent, projectId);
			try {
				await agent.destroy();
			} catch (error) {
				// The agent's own deferred abort can outrace the RPC reply in
				// production; children and storage are already gone by then.
				if (!isDurableObjectReset(error)) throw error;
			}
			return Response.json({ erased: true });
		}

		const hot = url.pathname.match(
			/^\/agents\/db-agent\/([^/]+)\/(collections|tables)\/([^/]+)(\/.*)?$/,
		);
		if (hot) {
			const projectId = decodeURIComponent(hot[1]);
			const shard = decodeURIComponent(hot[3]);
			if (
				!projectIdSchema.safeParse(projectId).success ||
				!collectionNameSchema.safeParse(shard).success
			) {
				return Response.json({ error: 'invalid project or shard name' }, { status: 400 });
			}
			// The two namespaces cannot cross wires: a name only routes within
			// its own kind's namespace, whatever the registry says about it.
			const namespace = hot[2] === 'tables' ? this.env.DbTable : this.env.DbCollection;
			const subPath = hot[4] ?? '/';

			// Replicated reads land on the caller's region replica; everything
			// else (and every non-replicated shard) keeps the primary hop.
			let instanceName = `${projectId}:${shard}`;
			let locationHint: DurableObjectLocationHint | undefined;
			if (
				isRoutableRead(hot[2], request.method, subPath) &&
				(await shardReplicationAuto(this.env, projectId, shard))
			) {
				// WebSocket clients cannot set headers, so the test override also
				// rides a query param (same env.test-only gate).
				const override =
					this.env.REGION_OVERRIDE_HEADER === 'true'
						? (request.headers.get('x-cfb-region') ?? url.searchParams.get('cfb-region'))
						: null;
				const region =
					override && REGION_HINTS.has(override)
						? override
						: regionHint(
								(
									request as Request & {
										cf?: { continent?: string; country?: string; longitude?: string };
									}
								).cf ?? {},
							);
				// Subscribers spread across siblings under socket pressure; every
				// other read keeps sibling 1.
				const sibling =
					subPath === '/subscribe'
						? await subscribeSibling(
								this.env,
								hot[2] as 'collections' | 'tables',
								projectId,
								shard,
								region,
							)
						: 1;
				instanceName = replicaName(instanceName, region, sibling);
				locationHint = region as DurableObjectLocationHint;
			}

			const stub = namespace.get(
				namespace.idFromName(instanceName),
				locationHint ? { locationHint } : undefined,
			);
			// The hot path is the whole customer-facing data API, so it gets the
			// same 5xx reporting as everything else - it used to return here,
			// outside the net below, which made a 500 on a document read or a
			// live-query upgrade invisible in every deployable.
			const hotResponse = (await stub.fetch(request)) as unknown as Response;
			await this.reportServerError(request, url, hotResponse);
			return hotResponse;
		}

		const response =
			(await routeAgentRequest(request, this.env)) ??
			Response.json({ error: 'not found' }, { status: 404 });

		await this.reportServerError(request, url, response);
		return response;
	}

	/** Records any 5xx leaving this worker. Never replaces the response. */
	private async reportServerError(request: Request, url: URL, response: Response): Promise<void> {
		if (response.status < 500) return;
		try {
			// A 101 upgrade has no body to clone; only real responses get here.
			const body = (await response.clone().text()).slice(0, 2048);
			Sentry.captureMessage(`Db agent returned HTTP ${response.status}`, {
				level: 'error',
				tags: {
					'http.method': request.method,
					'http.status_code': response.status,
				},
				contexts: {
					response: { body, contentType: response.headers.get('content-type') ?? '' },
				},
				extra: { pathname: url.pathname },
			});
		} catch {
			// reporting must never replace the response
		}
	}
}

export default Sentry.withSentry(sentryOptions, DbService);
