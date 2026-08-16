import { AGENT_REGISTRY } from '$lib/agent-registry';
import { agentUrl, assertProjectId, requireAgent, toNativeResponse } from '$lib/server/agents';
import type { RequestHandler } from './$types';

/** Operator proxy: list this project's storage buckets. */
export const GET: RequestHandler = async ({ params, url, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const entry = AGENT_REGISTRY.storage;
	const agent = requireAgent(platform, entry);
	const response = await agent.fetch(agentUrl(url.origin, entry, projectId, '/admin/buckets'));
	return toNativeResponse(response as unknown as Response);
};
