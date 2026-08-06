import { AGENT_REGISTRY } from '$lib/agent-registry';
import { dbOverviewSchema } from '$lib/agents';
import { agentUrl, assertProjectId, requireAgent, serverError } from '$lib/server/agents';
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** Pre-split deep links used ?tab=; the tool is a route segment now. */
const LEGACY_TABS: Record<string, string> = {
	tables: 'tables',
	access: 'access',
	replication: 'replication',
	setup: 'integration'
};

export const load: PageServerLoad = async ({ params, url, platform }) => {
	const projectId = assertProjectId(params.projectId);

	if (!params.tool) {
		const legacy = LEGACY_TABS[url.searchParams.get('tab') ?? ''];
		if (legacy) {
			const rest = new URLSearchParams(url.searchParams);
			rest.delete('tab');
			const suffix = rest.size ? `?${rest}` : '';
			redirect(308, `/dashboard/${projectId}/db/${legacy}${suffix}`);
		}
	}

	const entry = AGENT_REGISTRY.db;
	const agent = requireAgent(platform, entry);

	const response = await agent.fetch(agentUrl(url.origin, entry, projectId, '/overview'));
	if (!response.ok) {
		serverError(502, 'the db agent is unavailable');
	}
	const overview = dbOverviewSchema.safeParse(await response.json());
	if (!overview.success) {
		serverError(502, 'the db agent is unavailable');
	}

	return { projectId, overview: overview.data };
};
