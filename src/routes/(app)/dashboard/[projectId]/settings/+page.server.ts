import { canAdministerOrg } from '$lib/console';
import { isDemoProjectId } from '$lib/server/console';
import { assertProjectId } from '$lib/server/agents';
import { getProject } from '$lib/server/registry';
import type { PageServerLoad } from './$types';

/**
 * Project settings: the registry row behind this id. Demos and unregistered
 * ids have no row to manage - the sidebar only links here for registered
 * projects, but the URL is typeable, so the page explains instead of 404ing.
 */
export const load: PageServerLoad = async ({ locals, params, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const project = isDemoProjectId(projectId) ? null : await getProject(platform, projectId);

	// Deleting is org-administrator work (the DELETE route enforces it); an
	// unowned row has no org to have a role in, which is the self-hosted case.
	const role = project?.orgId
		? locals.consoleIdentity?.organizations.find((org) => org.id === project.orgId)?.role
		: null;
	const canDelete = project ? !project.orgId || canAdministerOrg(role) : false;

	return { projectId, project, canDelete };
};
