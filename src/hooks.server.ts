import { dev } from '$app/environment';
import { agentByApiPrefix, agentByWorkerSegment, routeAccess } from '$lib/agent-registry';
import { RESERVED_PROJECT_IDS } from '$lib/console';
import { projectIdSchema } from '$lib/schemas/auth';
import { agentFetcher, agentUrl } from '$lib/server/agents';
import { getConsoleIdentity, isDemoMode, isDemoProjectId } from '$lib/server/console';
import {
	deployTokenCoversProject,
	isDeployTokenSurface,
	verifyDeployToken
} from '$lib/server/hosting';
import { getProjectOwnership, type ProjectOwnership } from '$lib/server/registry';
import { handleErrorWithSentry, initCloudflareSentryHandle, sentryHandle } from '@sentry/sveltekit';
import { redirect } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import type { AppAgentEntry } from '$lib/agent-registry';
import type { Handle } from '@sveltejs/kit';

let platform: App.Platform;

if (dev) {
	const { getPlatformProxy } = await import('wrangler');

	// @ts-expect-error wrangler dev local context
	platform = await getPlatformProxy({
		persist: true,
		environment: 'local'
	});
}

const platformHandle: Handle = async ({ event, resolve }) => {
	if (platform) {
		event.platform = {
			...event.platform,
			...platform
		};
	}

	if (event.platform?.ctx) {
		(event.platform as App.Platform & { context: ExecutionContext }).context = event.platform.ctx;
	}

	return resolve(event);
};

/**
 * `/api/projects/<id>/<apiPrefix>/<rest>` -> the agent-worker URL the REST
 * proxy routes build, or null when the path is not an agent proxy. Mirrors
 * the translation `classifyAccess` does, so the guard and the passthrough
 * agree on what a proxied path means.
 */
function agentProxyTarget(url: URL): { entry: AppAgentEntry; target: string } | null {
	const segments = url.pathname.split('/').filter(Boolean);
	if (segments[0] !== 'api' || segments[1] !== 'projects') return null;

	const projectId = projectIdSchema.safeParse(segments[2]);
	const entry = segments[3] ? agentByApiPrefix(segments[3]) : undefined;
	if (!projectId.success || !entry) return null;

	const rest = segments.slice(4).join('/');
	const subPath = `${entry.manifest.proxy.agentBasePath}${rest ? `/${rest}` : ''}` || '/';
	return { entry, target: agentUrl(url.origin, entry, projectId.data, `${subPath}${url.search}`) };
}

const applicationHandle: Handle = async ({ event, resolve }) => {
	// Agent traffic (HTTP + WebSocket state sync) goes straight through to the
	// agent worker the manifest registry names for the path's worker segment.
	// In local dev the dashboard connects directly to the agent workers'
	// ports instead, since Vite's dev server can't proxy workerd WebSockets.
	if (event.url.pathname.startsWith('/agents/')) {
		const entry = agentByWorkerSegment(event.url.pathname.split('/')[2] ?? '');
		const agent = entry && agentFetcher(event.platform, entry);
		if (agent) {
			return agent.fetch(event.request) as unknown as Promise<Response>;
		}
	}

	// An upgrade aimed at the REST proxy base takes the SAME untouched
	// passthrough. The `+server.ts` proxies re-wrap every answer, and a 101
	// cannot be re-wrapped - its status is outside what `new Response` accepts
	// and the `webSocket` never survives a copy - so a subscribe that arrived
	// here died as a RangeError 500. The SDK rewrites a proxy base to
	// `/agents/...` for exactly this reason; raw clients that don't now work
	// too. Returning the fetcher's response verbatim is what makes it possible,
	// which only a hook can do.
	if (event.request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
		const proxied = agentProxyTarget(event.url);
		const agent = proxied && agentFetcher(event.platform, proxied.entry);
		if (proxied && agent) {
			// url + init, never a Request: the dev binding is a miniflare proxy
			// that cannot consume Requests from the Node realm.
			return agent.fetch(proxied.target, {
				method: event.request.method,
				headers: [...event.request.headers]
			}) as unknown as Promise<Response>;
		}
	}

	return resolve(event);
};

const apiRateLimitHandle: Handle = async ({ event, resolve }) => {
	if (event.url.pathname === '/api' || event.url.pathname.startsWith('/api/')) {
		const limiter = event.platform?.env?.API_RATE_LIMITER;

		if (limiter) {
			const { success } = await limiter.limit({ key: event.getClientAddress() });

			if (!success) {
				return Response.json(
					{ error: 'rate limit exceeded' },
					{
						status: 429,
						headers: { 'Retry-After': '60' }
					}
				);
			}
		}
	}

	return resolve(event);
};

type Access =
	| { scope: 'open' }
	| {
			scope: 'operator';
			projectId: string | null;
			kind: 'page' | 'api';
			/** The bare /dashboard entry, the only page demo mode hands to anonymous visitors. */
			demoEntry?: boolean;
	  };

/**
 * Splits project-scoped surfaces into public product API and operator console.
 *
 * Public routes are the ones each agent's manifest declares `public` - the
 * product API a customer's app calls, and safe client config. Everything else
 * - overviews, analytics, admin mutations, and the realtime WebSockets -
 * reads or mutates a project's user data and needs an operator. Undeclared
 * routes and unknown agents fail closed to operator.
 *
 * This is the single enforcement point for the `/agents/*` passthrough too.
 * The agent workers have no public route (`workers_dev` and `preview_urls`
 * are both false), so every external request to them arrives through here.
 */
function classifyAccess(pathname: string): Access {
	const segments = pathname.split('/').filter(Boolean);

	// /agents/<worker>/<projectId>/<subPath...>
	if (segments[0] === 'agents') {
		const entry = agentByWorkerSegment(segments[1] ?? '');
		const subPath = `/${segments.slice(3).join('/')}`;
		if (entry && routeAccess(entry.manifest, subPath) === 'public') {
			return { scope: 'open' };
		}
		return { scope: 'operator', projectId: segments[2] ?? null, kind: 'api' };
	}

	// Everything under /api is operator surface unless published below, so a
	// route added later is private until someone deliberately opens it.
	if (segments[0] === 'api') {
		// Registry mutations name their project in the path; surfacing the id
		// here is what routes them through the same ownership gate as the
		// project-scoped proxies (deleting or claiming a project is as
		// project-scoped as reading it).
		if (segments[1] === 'registry' && segments[2] === 'projects' && segments[3]) {
			return { scope: 'operator', projectId: segments[3], kind: 'api' };
		}
		if (segments[1] === 'projects') {
			const rest = segments.slice(3);
			// /api/projects/<id>/<apiPrefix>/... proxies onto an agent; translate
			// to the agent-relative path and ask its manifest route table.
			const entry = rest[0] ? agentByApiPrefix(rest[0]) : undefined;
			if (entry) {
				const restPath = rest.slice(1).join('/');
				const agentPath =
					`${entry.manifest.proxy.agentBasePath}${restPath ? `/${restPath}` : ''}` || '/';
				if (routeAccess(entry.manifest, agentPath) === 'public') {
					return { scope: 'open' };
				}
				return { scope: 'operator', projectId: segments[2] ?? null, kind: 'api' };
			}
			// /config and /openapi.json both describe the public product API and
			// carry no secrets; being fetchable is the point for API tooling.
			if (rest.length === 1 && (rest[0] === 'config' || rest[0] === 'openapi.json')) {
				return { scope: 'open' };
			}
			return { scope: 'operator', projectId: segments[2] ?? null, kind: 'api' };
		}
		return { scope: 'operator', projectId: null, kind: 'api' };
	}

	if (segments[0] === 'dashboard') {
		return {
			scope: 'operator',
			projectId: segments[1] ?? null,
			kind: 'page',
			demoEntry: segments.length === 1
		};
	}

	// The CLI login hand-off page: operator-only so a signed-out visitor
	// bounces through /login (social sign-in included) before approving.
	if (segments[0] === 'cli-auth') {
		return { scope: 'operator', projectId: null, kind: 'page' };
	}

	return { scope: 'open' };
}

/**
 * Requires an operator session for every console surface, and - since Phase A
 * of the managed service - membership in the owning org for project-scoped
 * ones. Fails closed: an install that never sets DEMO_MODE is private the
 * moment it is deployed.
 */
const consoleGuardHandle: Handle = async ({ event, resolve }) => {
	event.locals.demoMode = isDemoMode(event.platform);
	event.locals.consoleUser = null;
	event.locals.consoleIdentity = null;
	event.locals.deployToken = null;

	const access = classifyAccess(event.url.pathname);
	if (access.scope === 'open') return resolve(event);

	// Deploy tokens (docs/managed-service-design.md, Phase B): a `cfbd_` bearer
	// is CI's durable credential, accepted SOLELY on the deploy and
	// branch-create endpoints for the token's root project and its branches.
	// Any other use of one - wrong surface, wrong project, revoked - is a
	// plain 401 here, never a fall-through to session resolution: a deploy
	// token must never behave like a session.
	const bearer = event.request.headers
		.get('authorization')
		?.match(/^Bearer\s+(cfbd_[0-9a-f]{64})$/i)?.[1];
	if (bearer) {
		if (
			access.projectId &&
			isDeployTokenSurface(event.url.pathname, event.request.method) &&
			!isDemoProjectId(access.projectId)
		) {
			const grant = await verifyDeployToken(event.platform, bearer.toLowerCase());
			if (
				grant &&
				(await deployTokenCoversProject(event.platform, grant.projectId, access.projectId))
			) {
				event.locals.deployToken = grant;
				return resolve(event);
			}
		}
		return Response.json({ error: 'invalid deploy token' }, { status: 401 });
	}

	// Ownership of the target project, resolved once per request. Registered
	// rows carry their org; an unregistered demo id inherits a claimed root's
	// registration, so claiming ends anonymous access for the whole family.
	// Reserved ids (the console instance itself) are never registry rows.
	const ownership: ProjectOwnership | null =
		access.projectId && !RESERVED_PROJECT_IDS.has(access.projectId)
			? await getProjectOwnership(event.platform, access.projectId)
			: null;

	// Public demo: anonymous visitors may drive ephemeral demo projects, whose
	// ids are unguessable and whose data self-destructs. Named projects always
	// require an operator session, even on the demo deployment - and so does a
	// CLAIMED demo: the registry row is what flips it from possession-based to
	// owned (docs/managed-service-design.md).
	if (
		event.locals.demoMode &&
		access.projectId &&
		isDemoProjectId(access.projectId) &&
		!ownership?.registered
	) {
		// Access is anonymous, but a signed-in operator's identity must still
		// resolve: the demo layout's claim flow ("Keep this project", the
		// ?claim=1 post-login auto-claim) branches on it, and without this the
		// page renders anonymous even mid-claim - sign-in appeared to do
		// nothing. getConsoleIdentity no-ops without a cookie, so first-time
		// demo visits still skip the session lookup entirely.
		if (event.request.headers.get('cookie')) {
			event.locals.consoleIdentity = await getConsoleIdentity(
				event.platform,
				event.url.origin,
				event.request.headers.get('cookie')
			);
			event.locals.consoleUser = event.locals.consoleIdentity?.user ?? null;
		}
		return resolve(event);
	}

	// The bare /dashboard entry decides for itself: in demo mode it hands an
	// anonymous visitor a throwaway project, while a signed-in operator gets
	// the real project list. Its loader branches on consoleUser, so the
	// session must be resolved here too (getConsoleIdentity no-ops without a
	// cookie, keeping the first-time demo visit free of a session lookup).
	// Scoped to that one entry: other project-less operator pages (/cli-auth)
	// keep the hard bounce through /login even on the public demo.
	if (event.locals.demoMode && access.demoEntry) {
		event.locals.consoleIdentity = await getConsoleIdentity(
			event.platform,
			event.url.origin,
			event.request.headers.get('cookie')
		);
		event.locals.consoleUser = event.locals.consoleIdentity?.user ?? null;
		return resolve(event);
	}

	const identity = await getConsoleIdentity(
		event.platform,
		event.url.origin,
		event.request.headers.get('cookie'),
		event.request.headers.get('authorization')
	);

	if (identity) {
		event.locals.consoleIdentity = identity;
		event.locals.consoleUser = identity.user;

		// Owned projects require membership in the owning org. Rows with a null
		// org stay visible to any operator (the self-hosted contract), and
		// unregistered ids keep their pre-ownership behaviour.
		if (ownership?.registered && ownership.orgId) {
			const isMember = identity.organizations.some((org) => org.id === ownership.orgId);
			if (!isMember) {
				if (access.kind === 'page') {
					redirect(303, '/dashboard');
				}
				return Response.json({ error: 'you do not have access to this project' }, { status: 403 });
			}
		}
		return resolve(event);
	}

	if (access.kind === 'page') {
		redirect(303, `/login?next=${encodeURIComponent(event.url.pathname + event.url.search)}`);
	}
	return Response.json({ error: 'authentication required' }, { status: 401 });
};

const cloudflareSentryHandle: Handle = async (input) => {
	// One DSN for server and browser: a DSN is not a secret (it ships in the
	// client bundle by design), so the server reads the PUBLIC_ var too.
	const dsn = input.event.platform?.env?.PUBLIC_SENTRY_DSN;

	if (!dsn) {
		return input.resolve(input.event);
	}

	return initCloudflareSentryHandle({
		dsn,
		environment: dev
			? 'development'
			: input.event.url.hostname === 'cloudflarebase.com'
				? 'production'
				: 'preview',
		tracesSampleRate: 0.1
	})(input);
};

export const handle = sequence(
	platformHandle,
	cloudflareSentryHandle,
	sentryHandle(),
	apiRateLimitHandle,
	// Must precede applicationHandle: that one forwards /agents/* straight to
	// the agent worker, so the guard is the last chance to reject.
	consoleGuardHandle,
	applicationHandle
);
export const handleError = handleErrorWithSentry();
