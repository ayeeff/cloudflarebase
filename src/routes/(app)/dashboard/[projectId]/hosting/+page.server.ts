import { AGENT_REGISTRY } from '$lib/agent-registry';
import { hostingOverviewSchema } from '$lib/agents';
import { isDemoProjectId } from '$lib/console';
import { agentUrl, assertProjectId, requireAgent, serverError } from '$lib/server/agents';
import { githubAppConfig } from '$lib/server/github';
import { listConnections, listInstallationsForOrg } from '$lib/server/github-connect';
import { listAppClaims, listDeployTokens } from '$lib/server/hosting';
import { getBranchContext, getProjectOwnership } from '$lib/server/registry';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, url, platform }) => {
	const projectId = assertProjectId(params.projectId);

	// No demo hosting: the page renders the upsell instead of an agent round
	// trip (which would only provision a DO to say 403).
	if (isDemoProjectId(projectId)) {
		return {
			projectId,
			demo: true as const,
			overview: null,
			tokens: [],
			isRoot: false,
			github: { configured: false, installations: [], connections: [] }
		};
	}

	const entry = AGENT_REGISTRY.hosting;
	const agent = requireAgent(platform, entry);
	const response = await agent.fetch(agentUrl(url.origin, entry, projectId, '/overview'));
	if (!response.ok) {
		serverError(502, 'the hosting agent is unavailable');
	}
	const overview = hostingOverviewSchema.safeParse(await response.json());
	if (!overview.success) {
		serverError(502, 'the hosting agent is unavailable');
	}

	// Claims cover apps that are linked but never deployed; tokens are minted
	// on roots only (they cover the whole family).
	const claims = await listAppClaims(platform, projectId);
	const context = await getBranchContext(platform, projectId);
	const isRoot = !context || context.current === null;
	const tokens = isRoot ? await listDeployTokens(platform, context?.rootId ?? projectId) : [];

	// GitHub push-to-deploy, roots only - a connection covers the root and all
	// its branches, exactly like a deploy token. `configured: false` is the
	// self-hosted default and makes the page offer the manual flow instead.
	const appConfigured = Boolean(githubAppConfig(platform));
	const github = {
		configured: appConfigured,
		installations:
			appConfigured && isRoot
				? await listInstallationsForOrg(
						platform,
						(await getProjectOwnership(platform, projectId)).orgId
					)
				: [],
		connections: isRoot ? await listConnections(platform, projectId) : []
	};

	return {
		projectId,
		demo: false as const,
		overview: overview.data,
		claims,
		tokens,
		isRoot,
		github
	};
};
