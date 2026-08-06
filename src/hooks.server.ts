import { dev } from '$app/environment';
import { agentByApiPrefix, agentByWorkerSegment, routeAccess } from '$lib/agent-registry';
import { agentFetcher } from '$lib/server/agents';
import { getConsoleSession, isDemoMode, isDemoProjectId } from '$lib/server/console';
import { handleErrorWithSentry, initCloudflareSentryHandle, sentryHandle } from '@sentry/sveltekit';
import { redirect } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
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
 * Requires an operator session for every console surface. Fails closed: an
 * install that never sets DEMO_MODE is private the moment it is deployed.
 */
const consoleGuardHandle: Handle = async ({ event, resolve }) => {
	event.locals.demoMode = isDemoMode(event.platform);
	event.locals.consoleUser = null;

	const access = classifyAccess(event.url.pathname);
	if (access.scope === 'open') return resolve(event);

	// Public demo: anonymous visitors may drive ephemeral demo projects, whose
	// ids are unguessable and whose data self-destructs. Named projects always
	// require an operator session, even on the demo deployment.
	if (event.locals.demoMode && access.projectId && isDemoProjectId(access.projectId)) {
		return resolve(event);
	}

	// The bare /dashboard entry decides for itself: in demo mode it hands an
	// anonymous visitor a throwaway project, while a signed-in operator gets
	// the real project list. Its loader branches on consoleUser, so the
	// session must be resolved here too (getConsoleSession no-ops without a
	// cookie, keeping the first-time demo visit free of a session lookup).
	// Scoped to that one entry: other project-less operator pages (/cli-auth)
	// keep the hard bounce through /login even on the public demo.
	if (event.locals.demoMode && access.demoEntry) {
		event.locals.consoleUser = await getConsoleSession(
			event.platform,
			event.url.origin,
			event.request.headers.get('cookie')
		);
		return resolve(event);
	}

	const user = await getConsoleSession(
		event.platform,
		event.url.origin,
		event.request.headers.get('cookie'),
		event.request.headers.get('authorization')
	);

	if (user) {
		event.locals.consoleUser = user;
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
