import { AGENT_REGISTRY } from '$lib/agent-registry';
import { agentUrl, assertProjectId, requireAgent, toNativeResponse } from '$lib/server/agents';
import type { RequestHandler } from './$types';

/** Operator proxy: set one secret on a deployed app (`cloudflarebase secret set`). */
export const POST: RequestHandler = async ({ params, request, url, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const entry = AGENT_REGISTRY.hosting;
	const agent = requireAgent(platform, entry);
	const target = agentUrl(
		url.origin,
		entry,
		projectId,
		`/apps/${encodeURIComponent(params.appName)}/secrets`
	);
	const response = await agent.fetch(target, {
		method: 'POST',
		headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
		body: await request.arrayBuffer()
	});
	return toNativeResponse(response as unknown as Response);
};
