import { canAdministerOrg } from '$lib/console';
import { assertProjectId } from '$lib/server/auth-agent';
import { deleteProject, getProjectOwnership, renameProject } from '$lib/server/registry';
import type { RequestHandler } from './$types';

/**
 * Renames a project's display name. The id is immutable (it is the Durable
 * Object name in every agent); the name is presentation only.
 * Operator-only, via the console guard.
 */
export const PATCH: RequestHandler = async ({ params, platform, request }) => {
	const projectId = assertProjectId(params.projectId);
	const result = await renameProject(platform, projectId, await request.json().catch(() => null));

	if (!result.ok) {
		return Response.json({ error: result.error }, { status: result.status });
	}
	return Response.json({ project: result.project });
};

/**
 * Deletes a project's registration and erases its data in every agent.
 * Operator-only via the console guard, and among operators, org
 * administrators only.
 *
 * The guard proves MEMBERSHIP, which is the right key for reading and
 * building on a project and the wrong one for erasing it: deleting fans out a
 * real wipe across every agent and there is no undo. A teammate invited to
 * work on a project must not be able to destroy it and everything the rest of
 * the org built there.
 */
export const DELETE: RequestHandler = async ({ locals, params, platform }) => {
	const projectId = assertProjectId(params.projectId);

	const ownership = await getProjectOwnership(platform, projectId);
	if (ownership.orgId) {
		const role = locals.consoleIdentity?.organizations.find(
			(org) => org.id === ownership.orgId
		)?.role;
		if (!canAdministerOrg(role)) {
			return Response.json(
				{ error: 'only organization owners and admins can delete a project' },
				{ status: 403 }
			);
		}
	}

	const result = await deleteProject(platform, projectId);

	if (!result.ok) {
		return Response.json({ error: result.error }, { status: result.status });
	}

	// 207 when the registration is gone but an agent could not be reached: the
	// console is consistent, yet the project's data outlived its registration.
	return result.warning
		? Response.json({ deleted: true, warning: result.warning }, { status: 207 })
		: Response.json({ deleted: true });
};
