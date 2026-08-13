import { error } from '@sveltejs/kit';
import * as Sentry from '@sentry/sveltekit';
import { projectIdSchema } from '$lib/schemas/auth';
import type { AppAgentEntry } from '$lib/agent-registry';

/**
 * Throw a 5xx that Sentry actually sees.
 *
 * SvelteKit's `error()` produces an `HttpError`, and the framework returns it
 * to the client WITHOUT passing it to the `handleError` hook - so
 * `handleErrorWithSentry` never fires for any deliberate 500/502. Every
 * server-side failure the operator is shown should go through here instead.
 */
export function serverError(status: number, message: string, cause?: unknown): never {
	if (cause === undefined) {
		Sentry.captureMessage(message, { level: 'error', tags: { 'http.status_code': status } });
	} else {
		Sentry.captureException(cause, { level: 'error', tags: { 'http.status_code': status } });
	}
	error(status, message);
}

/**
 * One path segment built from an untrusted id.
 *
 * `encodeURIComponent` is not enough on its own: it leaves `.` alone, so an id
 * of `..` survives it intact and the URL parser then resolves it, climbing a
 * level out of the intended prefix. Encoding hides the slashes; this rejects
 * the dots.
 */
export function agentSegment(value: string): string {
	if (value === '.' || value === '..') error(400, 'invalid resource id');
	return encodeURIComponent(value);
}

/** Project ids become Durable Object names and cookie prefixes - keep them tame. */
export function assertProjectId(projectId: string | undefined): string {
	const parsed = projectIdSchema.safeParse(projectId);
	if (!parsed.success) {
		error(400, 'invalid project id - use lowercase letters, digits and dashes (max 48 chars)');
	}
	return parsed.data;
}

type AgentEnv = Partial<Record<AppAgentEntry['binding'], Fetcher>>;

/** The entry's service binding, or undefined - for callers that fall through. */
export function agentFetcher(
	platform: App.Platform | undefined,
	entry: AppAgentEntry
): Fetcher | undefined {
	return (platform?.env as AgentEnv | undefined)?.[entry.binding];
}

/** The entry's service binding, or a 500 naming the missing binding. */
export function requireAgent(platform: App.Platform | undefined, entry: AppAgentEntry): Fetcher {
	const agent = agentFetcher(platform, entry);
	if (!agent) {
		// One misdeployed binding 500s most of the console, so this is the
		// single highest-value capture in the app.
		serverError(500, `${entry.binding} service binding is not available`);
	}
	return agent;
}

/**
 * Builds the agent-worker URL for a project sub-path, preserving the caller's
 * origin so the agent resolves cookies/redirects against the dashboard.
 *
 * For any sub-path containing a ROUTE PARAMETER, use `agentProxyUrl` instead -
 * this one does not check where the result lands.
 */
export function agentUrl(
	origin: string,
	entry: AppAgentEntry,
	projectId: string,
	subPath: string
): string {
	return `${origin}/agents/${entry.manifest.worker}/${projectId}${subPath}`;
}

/**
 * Builds a proxy URL from a FIXED prefix plus an untrusted rest, and refuses
 * anything that does not land under that prefix.
 *
 * This is not paranoia, it is the fix for a live hole. SvelteKit decodes route
 * parameters, so `%2F` and `%2E%2E` arrive as real slashes and real dot
 * segments; interpolating them into a URL string hands the URL parser a
 * traversal, and it resolves it. `/api/projects/<id>/auth/..%2F..%2Fadmin%2Fusers`
 * therefore normalised to `/agents/auth-agent/<id>/admin/users` - the operator
 * user list - on a route the guard had already classified PUBLIC from its
 * `auth/` prefix, so it answered 200 to anyone. One more level up crossed into
 * another project entirely.
 *
 * Normalising first and then requiring the prefix is what makes this
 * encoding-agnostic: whatever the caller writes, the check runs on the path
 * the agent will actually see.
 */
export function agentProxyUrl(
	origin: string,
	entry: AppAgentEntry,
	projectId: string,
	prefix: string,
	rest: string,
	search = ''
): string {
	const base = `/agents/${entry.manifest.worker}/${projectId}${prefix}`;
	const url = new URL(`${origin}${base}${rest ? `/${rest}` : ''}${search}`);
	if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) {
		error(400, 'invalid agent path');
	}
	return url.toString();
}

/**
 * Re-wraps a service-binding response into a native Response. In dev the
 * binding returns miniflare's proxied Response, which fails SvelteKit's
 * `instanceof Response` check for endpoint handlers. Set-Cookie headers are
 * copied individually so multiple cookies survive the round trip.
 */
export function toNativeResponse(response: Response): Response {
	// `new Response` refuses any status outside 200-599, so re-wrapping a 101
	// WebSocket upgrade throws a RangeError - and the `webSocket` would not
	// survive the copy anyway. Upgrades are forwarded untouched by the hook
	// before routing reaches a proxy, so this is the belt to that braces: a
	// stray one passes through instead of 500ing the request.
	if (response.status < 200 || response.status > 599) return response;

	const headers = new Headers();
	response.headers.forEach((value, key) => {
		if (key.toLowerCase() !== 'set-cookie') headers.set(key, value);
	});
	for (const cookie of response.headers.getSetCookie?.() ?? []) {
		headers.append('set-cookie', cookie);
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}
