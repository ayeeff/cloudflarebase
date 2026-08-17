import { AGENT_REGISTRY } from '$lib/agent-registry';
import { agentUrl, assertProjectId, requireAgent, toNativeResponse } from '$lib/server/agents';
import type { RequestHandler } from './$types';

/**
 * Rotate the project's signed-URL signing secret - the revocation lever for
 * signed URLs, since a signature carries no identity to revoke individually.
 * Every outstanding URL stops verifying at once.
 */
export const POST: RequestHandler = async ({ params, url, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const entry = AGENT_REGISTRY.storage;
	const agent = requireAgent(platform, entry);
	const target = agentUrl(url.origin, entry, projectId, '/admin/signing/rotate');
	const response = await agent.fetch(target, { method: 'POST' });
	return toNativeResponse(response as unknown as Response);
};
