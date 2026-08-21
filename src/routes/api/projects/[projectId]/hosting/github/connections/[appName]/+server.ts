import { assertProjectId } from '$lib/server/agents';
import { disconnectRepository, updateConnectionSettings } from '$lib/server/github-connect';
import type { RequestHandler } from './$types';

/**
 * Edits build settings at any time. For a build-mode connection the workflow
 * file in the repository is rewritten FIRST (the settings live in it), then
 * the row - a failed commit changes nothing.
 */
export const PATCH: RequestHandler = async ({ params, request, url, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const result = await updateConnectionSettings(
		platform,
		projectId,
		params.appName,
		await request.json().catch(() => null),
		url.origin
	);
	if (!result.ok) {
		return Response.json({ error: result.error }, { status: result.status });
	}
	return Response.json({
		connection: result.connection,
		workflowRewritten: result.workflowRewritten
	});
};

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
