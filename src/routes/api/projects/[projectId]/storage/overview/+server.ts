import { AGENT_REGISTRY } from '$lib/agent-registry';
import { agentUrl, assertProjectId, requireAgent, toNativeResponse } from '$lib/server/agents';
import type { RequestHandler } from './$types';

/** Operator proxy: the project's storage overview (buckets, totals, caps). */
export const GET: RequestHandler = async ({ params, url, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const entry = AGENT_REGISTRY.storage;
	const agent = requireAgent(platform, entry);
	const response = await agent.fetch(agentUrl(url.origin, entry, projectId, '/overview'));
	return toNativeResponse(response as unknown as Response);
};
