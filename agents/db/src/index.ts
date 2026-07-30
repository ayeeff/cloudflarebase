import * as Sentry from '@sentry/cloudflare';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { getAgentByName, routeAgentRequest } from 'agents';
import { DbAgent as DbAgentBase } from './agent';
import { DbCollection as DbCollectionBase } from './collection';
import { collectionNameSchema, projectIdSchema } from './schemas';

export type { DbActivityEvent, DbAgentState, DbCollectionSummary, DbOverview } from './agent';
export type { AssertDbAgentEnv, DbAgentBindings } from './bindings';
export type {
	AccessMode,
	AggregateRequest,
	AggregateResult,
	CollectionValidator,
	DbDocument,
	FieldRule,
	ImportReport,
	Query,
	RestoreRequest,
	ServerFrame,
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
 * - everything else under /agents/* - routeAgentRequest -> DbAgent
 *   (/config, /overview, /admin/*, and the AgentClient state-sync socket).
 *   Never with `cors: true`: the agents own their per-project CORS policy.
 */
class DbService extends WorkerEntrypoint<Env> {
	async fetch(request: Request): Promise<Response> {
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
			await agent.destroy();
			return Response.json({ erased: true });
		}

		const hot = url.pathname.match(/^\/agents\/db-agent\/([^/]+)\/collections\/([^/]+)(\/.*)?$/);
		if (hot) {
			const projectId = decodeURIComponent(hot[1]);
			const collection = decodeURIComponent(hot[2]);
			if (
				!projectIdSchema.safeParse(projectId).success ||
				!collectionNameSchema.safeParse(collection).success
			) {
				return Response.json({ error: 'invalid project or collection name' }, { status: 400 });
			}
			const namespace = this.env.DbCollection;
			const stub = namespace.get(namespace.idFromName(`${projectId}:${collection}`));
			return stub.fetch(request) as unknown as Promise<Response>;
		}

		const response =
			(await routeAgentRequest(request, this.env)) ??
			Response.json({ error: 'not found' }, { status: 404 });

		if (response.status >= 500) {
			try {
				const clone = response.clone();
				const body = (await clone.text()).slice(0, 2048);
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
		return response;
	}
}

export default Sentry.withSentry(sentryOptions, DbService);
