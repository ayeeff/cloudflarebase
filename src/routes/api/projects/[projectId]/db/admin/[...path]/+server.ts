import { AGENT_REGISTRY } from '$lib/agent-registry';
import { agentProxyUrl, assertProjectId, requireAgent, toNativeResponse } from '$lib/server/agents';
import type { RequestHandler } from './$types';

/**
 * Operator passthrough (console guard) for the db agent's admin surface:
 * collection create/configure/delete, the dashboard's document browser
 * (`POST /admin/query`), operator document edits, and settings. The agent
 * validates every body; this proxy only forwards.
 */
const proxy: RequestHandler = async ({ params, request, url, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const entry = AGENT_REGISTRY.db;
	const agent = requireAgent(platform, entry);

	// agentProxyUrl: a decoded traversal in `params.path` would otherwise
	// climb out of this project's /admin prefix into another project's.
	const target = agentProxyUrl(url.origin, entry, projectId, '/admin', params.path, url.search);
	const body =
		request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();

	const response = await agent.fetch(target, {
		method: request.method,
		headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
		body
	});
	return toNativeResponse(response as unknown as Response);
};

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
// PATCH arrived with the admin get/patch pair (docs/admin-sdk-design.md 5.1).
// The catch-all forwards any path, but SvelteKit routes by EXPORTED method, so
// an unexported verb 405s at the router and never reaches the agent.
export const PATCH = proxy;
export const DELETE = proxy;
