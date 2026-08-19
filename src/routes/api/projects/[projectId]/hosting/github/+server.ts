import { assertProjectId } from '$lib/server/agents';
import { githubAppConfig } from '$lib/server/github';
import { listConnections, listInstallationsForOrg } from '$lib/server/github-connect';
import { getProjectOwnership } from '$lib/server/registry';
import type { RequestHandler } from './$types';

/**
 * GitHub push-to-deploy state for the Hosting page (* Phase B). `configured: false` is the self-hosted default - no App
 * credentials, so the page offers the manual deploy-token flow instead.
 */
export const GET: RequestHandler = async ({ params, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const config = githubAppConfig(platform);
	if (!config) {
		return Response.json({ configured: false, installations: [], connections: [] });
	}

	// Installations are offered per owning org, so a teammate's install is
	// reusable and a stranger's is invisible.
	const ownership = await getProjectOwnership(platform, projectId);
	return Response.json({
		configured: true,
		installations: await listInstallationsForOrg(platform, ownership.orgId),
		connections: await listConnections(platform, projectId)
	});
};
