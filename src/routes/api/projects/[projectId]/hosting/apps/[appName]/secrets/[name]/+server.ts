import { AGENT_REGISTRY } from '$lib/agent-registry';
import {
	agentSegment,
	agentUrl,
	assertProjectId,
	requireAgent,
	toNativeResponse
} from '$lib/server/agents';
import type { RequestHandler } from './$types';

/** Operator proxy: delete one secret from a deployed app. Idempotent - the
 * agent removes the script binding (404-tolerant) and drops the name row. */
export const DELETE: RequestHandler = async ({ params, url, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const entry = AGENT_REGISTRY.hosting;
	const agent = requireAgent(platform, entry);
	const target = agentUrl(
		url.origin,
		entry,
		projectId,
		`/apps/${agentSegment(params.appName)}/secrets/${agentSegment(params.name)}`
	);
	const response = await agent.fetch(target, { method: 'DELETE' });
	return toNativeResponse(response as unknown as Response);
};
