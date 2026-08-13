import { assertProjectId } from '$lib/server/agents';
import { disconnectRepository } from '$lib/server/github-connect';
import type { RequestHandler } from './$types';

/**
 * Disconnecting IS deleting the row - a repository with no connection cannot
 * deploy, whatever it still holds in `.github/workflows`. Removing the
 * workflow file is attempted too, and reported, but never blocks.
 */
export const DELETE: RequestHandler = async ({ params, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const result = await disconnectRepository(platform, projectId, params.appName);
	if (!result.ok) {
		return Response.json({ error: 'no such connection' }, { status: 404 });
	}
	return Response.json({ ok: true, workflowRemoved: result.workflowRemoved });
};
