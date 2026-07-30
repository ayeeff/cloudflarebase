import { AGENT_REGISTRY } from '$lib/agent-registry';
import { agentUrl, assertProjectId, requireAgent, toNativeResponse } from '$lib/server/agents';
import type { RequestHandler } from './$types';

/**
 * Public passthrough for the db agent's document API (access modes are
 * enforced inside the collection Durable Object against project JWTs, the
 * same trust shape as the auth proxy). WebSocket subscriptions do NOT go
 * through here - browsers hit /agents/db-agent/... directly, exactly like
 * the dashboard's own realtime socket.
 */
const proxy: RequestHandler = async ({ params, request, url, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const entry = AGENT_REGISTRY.db;
	const agent = requireAgent(platform, entry);

	const target = agentUrl(url.origin, entry, projectId, `/collections/${params.path}${url.search}`);
	const body =
		request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
	const headers = new Headers(request.headers);
	const country = (request as Request & { cf?: { country?: string } }).cf?.country;
	// Service-binding requests do not retain the outer request.cf object. Carry
	// the edge-resolved country explicitly so the agent can write it to WAE.
	if (country) headers.set('cf-ipcountry', country);

	// Pass url + init (not a Request object): in dev the service binding is a
	// miniflare proxy that can't consume Requests from the Node realm.
	const response = await agent.fetch(target, {
		method: request.method,
		headers: [...headers],
		body
	});
	return toNativeResponse(response as unknown as Response);
};

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
