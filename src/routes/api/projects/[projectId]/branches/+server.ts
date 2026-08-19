import { assertProjectId } from '$lib/server/auth-agent';
import { createBranch, listBranches } from '$lib/server/registry';
import type { RequestHandler } from './$types';

/**
 * Branches of one root project. Operator-only via
 * the console guard. A branch is a full registry row whose id is
 * `<rootId>--<branch>` - creating one needs no agent calls (instances spawn
 * lazily on first touch), and deleting one is the ordinary project delete
 * (`DELETE /api/registry/projects/<rootId>--<branch>`).
 */

export const GET: RequestHandler = async ({ params, platform }) => {
	const rootId = assertProjectId(params.projectId);
	return Response.json({ branches: await listBranches(platform, rootId) });
};

export const POST: RequestHandler = async ({ params, platform, request }) => {
	const rootId = assertProjectId(params.projectId);
	const result = await createBranch(platform, rootId, await request.json().catch(() => null));

	if (!result.ok) {
		return Response.json({ error: result.error }, { status: result.status });
	}
	return Response.json({ branch: result.project }, { status: 201 });
};
