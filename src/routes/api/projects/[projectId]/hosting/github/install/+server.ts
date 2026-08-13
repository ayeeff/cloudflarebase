import { assertProjectId } from '$lib/server/agents';
import { isDemoProjectId } from '$lib/console';
import { githubAppConfig, installUrl, signInstallState } from '$lib/server/github';
import type { RequestHandler } from './$types';

/**
 * Where the operator goes to install the App and pick repositories.
 *
 * The `state` is signed and carries the operator and the project, which is
 * what lets the callback trust the `installation_id` GitHub hands back on a
 * redirect anyone could otherwise craft.
 */
export const GET: RequestHandler = async ({ params, platform, locals }) => {
	const projectId = assertProjectId(params.projectId);
	if (isDemoProjectId(projectId)) {
		return Response.json({ error: 'demo projects cannot deploy apps' }, { status: 403 });
	}
	const config = githubAppConfig(platform);
	if (!config) {
		return Response.json({ error: 'no GitHub App is configured on this console' }, { status: 503 });
	}
	if (!locals.consoleUser) {
		// The guard already required a session; this keeps the type honest.
		return Response.json({ error: 'sign in first' }, { status: 401 });
	}

	const state = await signInstallState(config, { projectId, userId: locals.consoleUser.id });
	return Response.json({ url: installUrl(config, state) });
};
