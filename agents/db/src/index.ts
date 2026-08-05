import * as Sentry from '@sentry/cloudflare';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { getAgentByName, routeAgentRequest } from 'agents';
import { drainUnusedBody } from './access';
import { isDurableObjectReset, DbAgent as DbAgentBase } from './agent';
import { DbCollection as DbCollectionBase } from './collection';
import { DbTable as DbTableBase } from './table';
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
			const stub = namespace.get(namespace.idFromName(`${projectId}:${shard}`));
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
