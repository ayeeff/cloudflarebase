import { AGENT_REGISTRY } from '$lib/agent-registry';
import {
	agentSegment,
	agentUrl,
	assertProjectId,
	requireAgent,
	toNativeResponse
} from '$lib/server/agents';
import type { RequestHandler } from './$types';

/** Operator proxy: replace an app's build-time vars (the whole set - absent
 * names are deletions). The workflow fetches them before its build step. */
export const PUT: RequestHandler = async ({ params, request, url, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const entry = AGENT_REGISTRY.hosting;
	const agent = requireAgent(platform, entry);
	const target = agentUrl(
		url.origin,
		entry,
		projectId,
		`/apps/${agentSegment(params.appName)}/build-vars`
	);
	const response = await agent.fetch(target, {
		method: 'PUT',
		headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
		body: await request.arrayBuffer()
	});
	return toNativeResponse(response as unknown as Response);
};
