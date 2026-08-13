import { assertProjectId } from '$lib/server/agents';
import { connectRepository, listConnections } from '$lib/server/github-connect';
import type { RequestHandler } from './$types';

/**
 * Repository connections, console-plane (docs/managed-service-design.md,
 * Phase B). Made on ROOT projects; a push to a git branch deploys
 * `<root>--<branch>` through the same connection.
 */

export const GET: RequestHandler = async ({ params, platform }) => {
	const projectId = assertProjectId(params.projectId);
	return Response.json({ connections: await listConnections(platform, projectId) });
};

export const POST: RequestHandler = async ({ params, request, url, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const result = await connectRepository(
		platform,
		projectId,
		await request.json().catch(() => null),
		// The origin is baked into the workflow AND is the OIDC audience, so it
		// has to be this deployment's own - never a value from the request body.
		url.origin
	);
	if (!result.ok) {
		return Response.json({ error: result.error }, { status: result.status });
	}
	return Response.json(
		{
			connection: result.connection,
			subdomain: result.subdomain,
			workflowWritten: result.workflowWritten
		},
		{ status: 201 }
	);
};
