import { AGENT_REGISTRY } from '$lib/agent-registry';
import {
	agentSegment,
	agentUrl,
	assertProjectId,
	requireAgent,
	toNativeResponse
} from '$lib/server/agents';
import type { RequestHandler } from './$types';

/** Operator proxy: per-app request analytics (`?days=7|30|90`). */
export const GET: RequestHandler = async ({ params, url, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const entry = AGENT_REGISTRY.hosting;
	const agent = requireAgent(platform, entry);
	const target = agentUrl(
		url.origin,
		entry,
		projectId,
		`/apps/${agentSegment(params.appName)}/analytics${url.search}`
	);
	const response = await agent.fetch(target);
	return toNativeResponse(response as unknown as Response);
};
