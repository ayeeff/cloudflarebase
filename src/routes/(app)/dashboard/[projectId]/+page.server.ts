import { AGENT_REGISTRY } from '$lib/agent-registry';
import type { AuthOverview, DbOverview } from '$lib/agents';
import { agentUrl as genericAgentUrl, agentFetcher } from '$lib/server/agents';
import { agentUrl, assertProjectId, requireAuthAgent } from '$lib/server/auth-agent';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** Project Overview - a light snapshot for the product cards. */
export const load: PageServerLoad = async ({ params, url, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const agent = requireAuthAgent(platform);

	const response = await agent.fetch(agentUrl(url.origin, projectId, '/overview'));
	if (!response.ok) {
		error(502, `auth agent responded with ${response.status}`);
	}
	const overview = (await response.json()) as AuthOverview;

	// The db card degrades to null rather than failing the page: auth is the
	// primary surface here, and a fork may not have deployed the db agent yet.
	let dbOverview: DbOverview | null = null;
	try {
		const db = agentFetcher(platform, AGENT_REGISTRY.db);
		if (db) {
			const dbResponse = await db.fetch(
				genericAgentUrl(url.origin, AGENT_REGISTRY.db, projectId, '/overview')
			);
			if (dbResponse.ok) dbOverview = (await dbResponse.json()) as DbOverview;
		}
	} catch {
		// card renders without live counts
	}

	return { projectId, overview, dbOverview };
};
