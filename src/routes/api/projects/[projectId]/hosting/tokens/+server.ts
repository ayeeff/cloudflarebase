import { assertProjectId } from '$lib/server/agents';
import { listDeployTokens, mintDeployToken } from '$lib/server/hosting';
import type { RequestHandler } from './$types';

/**
 * Deploy tokens, console-plane (Phase B).
 * Minted on ROOT projects from the Hosting page; the secret appears exactly
 * once in the mint response and only its SHA-256 digest is stored.
 */

export const GET: RequestHandler = async ({ params, platform }) => {
	const projectId = assertProjectId(params.projectId);
	return Response.json({ tokens: await listDeployTokens(platform, projectId) });
};

export const POST: RequestHandler = async ({ params, request, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const result = await mintDeployToken(platform, projectId, await request.json().catch(() => null));
	if (!result.ok) {
		return Response.json({ error: result.error }, { status: result.status });
	}
	return Response.json(
		{ id: result.id, name: result.name, token: result.token, createdAt: result.createdAt },
		{ status: 201 }
	);
};
