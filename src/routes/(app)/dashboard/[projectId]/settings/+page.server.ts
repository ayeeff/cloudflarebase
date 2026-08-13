import { isDemoProjectId } from '$lib/server/console';
import { assertProjectId } from '$lib/server/agents';
import { getProject } from '$lib/server/registry';
import type { PageServerLoad } from './$types';

/**
 * Project settings: the registry row behind this id. Demos and unregistered
 * ids have no row to manage - the sidebar only links here for registered
 * projects, but the URL is typeable, so the page explains instead of 404ing.
 */
export const load: PageServerLoad = async ({ params, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const project = isDemoProjectId(projectId) ? null : await getProject(platform, projectId);
	return { projectId, project };
};
