import {
	agentUrl,
	assertProjectId,
	requireAuthAgent,
	toNativeResponse
} from '$lib/server/auth-agent';
import type { RequestHandler } from './$types';

/**
 * Same-origin proxy for a project's Better Auth endpoints. The browser calls
 * /api/projects/<id>/auth/* and we forward to that project's AuthAgent over
 * the service binding, so auth cookies live on the dashboard origin.
 */
const proxy: RequestHandler = async ({ params, request, url, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const agent = requireAuthAgent(platform);

	const target = agentUrl(url.origin, projectId, `/api/auth/${params.path}${url.search}`);
	const body =
		request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
	const headers = new Headers(request.headers);
	const country = (request as Request & { cf?: { country?: string } }).cf?.country;
	// Service-binding requests do not retain the outer request.cf object. Carry
	// the edge-resolved country explicitly so the AuthAgent can write it to WAE.
	if (country) headers.set('cf-ipcountry', country);

	// Pass url + init (not a Request object): in dev the service binding is a
	// miniflare proxy that can't consume Requests from the Node realm.
	// redirect: 'manual' because Better Auth answers OAuth callbacks and emailed
	// links with 302s the BROWSER must follow. fetch's default 'follow' replays
	// the Location against this same service binding - which routes by binding,
	// not host, so the agent worker sees a non-/agents path and 404s - and the
	// session Set-Cookie riding the redirect is swallowed with it.
	const response = await agent.fetch(target, {
		method: request.method,
		headers: [...headers],
		body,
		redirect: 'manual'
	});
	return toNativeResponse(response as unknown as Response);
};

export const GET = proxy;
export const POST = proxy;
export const OPTIONS = proxy;
