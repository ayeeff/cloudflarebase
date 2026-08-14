import { dev } from '$app/environment';
import { agentByApiPrefix, agentByWorkerSegment, routeAccess } from '$lib/agent-registry';
import { CONSOLE_DASHBOARD_PAGES, CONSOLE_PROJECT_ID, RESERVED_PROJECT_IDS } from '$lib/console';
import { projectIdSchema } from '$lib/schemas/auth';
import { agentFetcher, agentUrl, serverError } from '$lib/server/agents';
import { isDemoMode, isDemoProjectId, resolveConsoleIdentity } from '$lib/server/console';
import { verifyGithubDeployGrant } from '$lib/server/github-connect';
import {
	deployTokenCoversProject,
	isDeployTokenSurface,
	verifyDeployToken
} from '$lib/server/hosting';
import { getProjectOwnership, projectExists, type ProjectOwnership } from '$lib/server/registry';
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
	// `/admin` is in scope as well as `/api`: its login action is a password
	// form the console guard never sees (the route classifies as open and
	// carries its own ADMIN_SECRET check), so without this it is the one
	// credential surface on the deployment that nothing throttles at all. It
	// also fans out to every project agent once authenticated.
	const limited =
		event.url.pathname === '/api' ||
		event.url.pathname.startsWith('/api/') ||
		event.url.pathname === '/admin' ||
		event.url.pathname.startsWith('/admin/');
	if (limited) {
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
	| {
			scope: 'open';
			/**
			 * The project a PUBLIC route addresses, when it addresses one. Open
			 * does not mean unaddressed: the product API is public on purpose and
			 * still names a project, whose Durable Objects it provisions on first
			 * touch - so the id still has to be one this installation knows.
			 */
			projectId?: string | null;
	  }
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
			return { scope: 'open', projectId: segments[2] ?? null };
		}
		return { scope: 'operator', projectId: segments[2] ?? null, kind: 'api' };
	}

	// Everything under /api is operator surface unless published below, so a
	// route added later is private until someone deliberately opens it.
	if (segments[0] === 'api') {
		// The two GitHub routes the guard cannot gate, both authenticated by an
		// HMAC we control rather than by a session:
		//
		// - `webhook`: GitHub carries no session and never will. Its
		//   X-Hub-Signature-256 is the credential, checked over the raw body.
		// - `callback`: the return leg of an App install. It arrives as a
		//   cross-site top-level navigation from github.com, where a session
		//   cookie is not reliably present - requiring one stranded operators
		//   mid-install. The signed install state IS the credential here: it is
		//   minted only for a signed-in operator on a specific project, expires
		//   in minutes, and cannot be forged without the webhook secret. The
		//   route verifies it before writing anything, and still cross-checks a
		//   session when the browser does send one.
		if (
			segments[1] === 'github' &&
			segments.length === 3 &&
			(segments[2] === 'webhook' || segments[2] === 'callback')
		) {
			return { scope: 'open' };
		}
		// Registry mutations name their project in the path; surfacing the id
		// here is what routes them through the same ownership gate as the
		// project-scoped proxies (deleting a project is as project-scoped as
		// reading it).
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
					return { scope: 'open', projectId: segments[2] ?? null };
				}
				return { scope: 'operator', projectId: segments[2] ?? null, kind: 'api' };
			}
			// /config and /openapi.json both describe the public product API and
			// carry no secrets; being fetchable is the point for API tooling.
			if (rest.length === 1 && (rest[0] === 'config' || rest[0] === 'openapi.json')) {
				return { scope: 'open', projectId: segments[2] ?? null };
			}
			return { scope: 'operator', projectId: segments[2] ?? null, kind: 'api' };
		}
		return { scope: 'operator', projectId: null, kind: 'api' };
	}

	if (segments[0] === 'dashboard') {
		// A static console page (/dashboard/organization) is not a project page.
		// SvelteKit resolves it ahead of [projectId]; classifying it as a
		// project would hand it a reserved id and get it refused below.
		if (segments[1] && CONSOLE_DASHBOARD_PAGES.has(segments[1])) {
			return { scope: 'operator', projectId: null, kind: 'page' };
		}
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
 * The guard's answer when the auth agent could not verify the session at all.
 * A 503, never a bounce to /login: the operator's credentials are not the
 * problem, and re-entering them cannot help.
 */
function cannotVerifySession(kind: 'page' | 'api'): Response {
	if (kind === 'page') {
		// serverError, not error(): a 503 the operator sees is one Sentry must
		// see too, and a bare `error()` never reaches handleError.
		serverError(503, 'Cannot verify your session right now. Please retry in a moment.');
	}
	return Response.json(
		{ error: 'cannot verify your session right now' },
		{ status: 503, headers: { 'Retry-After': '5' } }
	);
}

/**
 * Whether a PUBLIC project route may reach its project.
 *
 * Three ids qualify without a registry row: demo projects (throwaway by
 * construction, never rows, and only while demo mode is on), and `console`,
 * whose public auth surface is what the login page is built on. Everything
 * else must be a project this installation actually minted.
 *
 * Fails OPEN when the control plane cannot answer - deliberately the opposite
 * of the operator paths. What this gate prevents is unbounded Durable Object
 * creation, a cost problem; failing closed would turn a D1 blip into every
 * customer's app losing authentication, which is a worse outage than the
 * abuse it defends against, and it is the behaviour the platform had all
 * along.
 */
async function publicProjectReachable(
	event: Parameters<Handle>[0]['event'],
	projectId: string
): Promise<boolean> {
	if (projectId === CONSOLE_PROJECT_ID) return true;
	if (event.locals.demoMode && isDemoProjectId(projectId)) return true;
	return (await projectExists(event.platform, projectId)) !== false;
}

/**
 * "This project is not yours to reach" - deliberately the SAME answer for a
 * project that does not exist, one someone else owns, and one whose id is
 * reserved. Distinguishing them would turn the guard into an oracle for
 * enumerating other tenants' project ids.
 */
function noSuchProject(kind: 'page' | 'api'): Response {
	if (kind === 'page') redirect(303, '/dashboard');
	return Response.json({ error: 'no such project' }, { status: 404 });
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
	event.locals.githubDeploy = null;

	const access = classifyAccess(event.url.pathname);
	if (access.scope === 'open') {
		// Public still has to mean "public surface of a project that exists".
		// The agents provision a Durable Object on first touch, so a sign-up
		// against an invented id minted a fresh database - anonymously,
		// unboundedly, for an id nobody owns and no console can ever erase.
		if (access.projectId && !(await publicProjectReachable(event, access.projectId))) {
			return noSuchProject('api');
		}
		return resolve(event);
	}

	// Reserved ids are not projects. Everything except `console` names a
	// dashboard route or a system endpoint and has no instance behind it worth
	// reaching, so it is refused here - before the session is resolved, so the
	// answer cannot depend on who is asking. `console` DOES have an instance
	// (the operator accounts themselves) and is admin-gated further down,
	// after the identity is known.
	if (
		access.projectId &&
		access.projectId !== CONSOLE_PROJECT_ID &&
		RESERVED_PROJECT_IDS.has(access.projectId)
	) {
		return noSuchProject(access.kind);
	}

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

	// GitHub Actions OIDC (docs/managed-service-design.md, Phase B): a
	// `build`-mode connection deploys with NO stored credential at all - the
	// workflow presents a short-lived token GitHub signed, describing the
	// repository it ran in, and the connection table says which project that
	// repository may deploy to. Same surfaces and same all-or-nothing contract
	// as a deploy token: never a fall-through to session resolution.
	//
	// Only attempted on the deploy surfaces, so a three-segment console session
	// bearer on any other route still reaches the session path below.
	const oidcBearer =
		access.projectId && isDeployTokenSurface(event.url.pathname, event.request.method)
			? event.request.headers
					.get('authorization')
					?.match(/^Bearer\s+([\w-]+\.[\w-]+\.[\w-]+)$/)?.[1]
			: undefined;
	if (oidcBearer) {
		const grant = await verifyGithubDeployGrant(
			event.platform,
			oidcBearer,
			event.url.origin,
			access.projectId!
		);
		if (grant) {
			event.locals.githubDeploy = grant;
			return resolve(event);
		}
		return Response.json({ error: 'invalid GitHub deploy token' }, { status: 401 });
	}

	// Public demo: anonymous visitors may drive ephemeral demo projects, whose
	// ids are unguessable and whose data self-destructs after the TTL. Demos
	// are throwaway - never registry rows, never owned - so the visit skips
	// the ownership lookup and the session resolution entirely. Named projects
	// always require an operator session, even on the demo deployment.
	if (event.locals.demoMode && access.projectId && isDemoProjectId(access.projectId)) {
		return resolve(event);
	}

	// Ownership of the target project, resolved once per request. The console
	// instance is exempt: it is not a registry row and answers to the admin
	// role instead, checked below once the identity is known.
	const ownership: ProjectOwnership | null =
		access.projectId && access.projectId !== CONSOLE_PROJECT_ID
			? await getProjectOwnership(event.platform, access.projectId)
			: null;

	// Cloudflare resolves the client address at the edge; a service-binding
	// fetch keeps none of it, so the guard has to carry it to the agent by
	// hand or the agent's per-IP rate limiter degrades to one shared bucket
	// for the whole console (see sessionLookupHeaders).
	const clientIp = event.request.headers.get('cf-connecting-ip');

	// The bare /dashboard entry decides for itself: in demo mode it hands an
	// anonymous visitor a throwaway project, while a signed-in operator gets
	// the real project list. Its loader branches on consoleUser, so the
	// session must be resolved here too (the lookup no-ops without a cookie,
	// keeping the first-time demo visit free of a session round trip).
	// Scoped to that one entry: other project-less operator pages (/cli-auth)
	// keep the hard bounce through /login even on the public demo.
	if (event.locals.demoMode && access.demoEntry) {
		const resolved = await resolveConsoleIdentity(
			event.platform,
			event.url.origin,
			event.request.headers.get('cookie'),
			null,
			clientIp
		);
		if (resolved.status === 'unavailable') return cannotVerifySession(access.kind);
		event.locals.consoleIdentity = resolved.status === 'ok' ? resolved.identity : null;
		event.locals.consoleUser = event.locals.consoleIdentity?.user ?? null;
		return resolve(event);
	}

	const resolved = await resolveConsoleIdentity(
		event.platform,
		event.url.origin,
		event.request.headers.get('cookie'),
		event.request.headers.get('authorization'),
		clientIp
	);

	// Could not CHECK is not the same answer as not signed in, and the
	// difference is the whole user experience: bouncing to /login here loops
	// (that page resolves the session the same way and fails the same way) and
	// asks an operator to retype credentials against an outage they cannot
	// fix. Say so instead, and let the request be retried.
	if (resolved.status === 'unavailable') return cannotVerifySession(access.kind);

	const identity = resolved.status === 'ok' ? resolved.identity : null;

	if (identity) {
		event.locals.consoleIdentity = identity;
		event.locals.consoleUser = identity.user;

		// The console's own instance holds every operator account on the
		// deployment, so it is administered, not owned: no registry row can
		// speak for it, and membership in some org says nothing about it. The
		// admin role is the only key, and a non-admin gets the same "no such
		// project" as everyone else rather than a hint that it exists.
		if (access.projectId === CONSOLE_PROJECT_ID) {
			if (identity.user.role !== 'admin') return noSuchProject(access.kind);
			return resolve(event);
		}

		if (ownership) {
			// A control plane that cannot answer must not read as "not yours" -
			// the ownership lookup returns `unavailable` for that, distinct from
			// a row that genuinely is not there.
			if (ownership.unavailable) return cannotVerifySession(access.kind);

			// An id with no registry row is nobody's project, and reaching one
			// used to MINT a working backend by URL: the agents provision a
			// Durable Object on first touch, so /dashboard/<anything> handed out
			// an auth stack and a database outside every org ceiling - and any
			// other account guessing the same id landed in the same data.
			if (!ownership.registered) return noSuchProject(access.kind);

			// Owned rows require membership in the owning org. Rows with a null
			// org predate ownership and stay visible to any operator - the
			// self-hosted contract, where every operator is the same person.
			if (ownership.orgId) {
				const isMember = identity.organizations.some((org) => org.id === ownership.orgId);
				if (!isMember) return noSuchProject(access.kind);
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
