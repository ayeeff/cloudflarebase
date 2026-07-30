import { AGENT_REGISTRY } from '$lib/agent-registry';
import { dbOverviewSchema } from '$lib/agents';
import { agentUrl, assertProjectId, requireAgent } from '$lib/server/agents';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, url, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const entry = AGENT_REGISTRY.db;
	const agent = requireAgent(platform, entry);

	const response = await agent.fetch(agentUrl(url.origin, entry, projectId, '/overview'));
	if (!response.ok) {
		error(502, 'the db agent is unavailable');
	}
	const overview = dbOverviewSchema.safeParse(await response.json());
	if (!overview.success) {
		error(502, 'the db agent is unavailable');
	}

	return { projectId, overview: overview.data };
};
