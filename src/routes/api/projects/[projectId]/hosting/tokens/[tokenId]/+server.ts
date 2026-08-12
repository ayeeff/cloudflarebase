import { assertProjectId } from '$lib/server/agents';
import { revokeDeployToken } from '$lib/server/hosting';
import type { RequestHandler } from './$types';

/** Revocation IS deletion: a token whose row is gone can never verify again. */
export const DELETE: RequestHandler = async ({ params, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const revoked = await revokeDeployToken(platform, projectId, params.tokenId);
	if (!revoked) {
		return Response.json({ error: 'no such token' }, { status: 404 });
	}
	return Response.json({ revoked: true });
};
