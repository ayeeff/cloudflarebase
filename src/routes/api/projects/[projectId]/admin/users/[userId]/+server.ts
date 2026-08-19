import { agentSegment } from '$lib/server/agents';
import {
	agentUrl,
	assertProjectId,
	requireAuthAgent,
	toNativeResponse
} from '$lib/server/auth-agent';
import type { RequestHandler } from './$types';

/** Read one account. Added with the server-side service path
 *: the surface could list users and delete
 * them, but never fetch one by id. */
export const GET: RequestHandler = async ({ params, url, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const agent = requireAuthAgent(platform);
	const response = await agent.fetch(
		agentUrl(url.origin, projectId, `/admin/users/${agentSegment(params.userId)}`)
	);
	return toNativeResponse(response as unknown as Response);
};

/** Update name, email, or the verified flag. NOT role - that stays on
 * `PUT /admin/users/:id/role`, the single writer whose console lockout guards
 * must not be reachable around. */
export const PATCH: RequestHandler = async ({ params, request, url, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const agent = requireAuthAgent(platform);
	const response = await agent.fetch(
		agentUrl(url.origin, projectId, `/admin/users/${agentSegment(params.userId)}`),
		{
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: await request.arrayBuffer()
		}
	);
	return toNativeResponse(response as unknown as Response);
};

export const DELETE: RequestHandler = async ({ params, url, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const agent = requireAuthAgent(platform);
	const response = await agent.fetch(
		agentUrl(url.origin, projectId, `/admin/users/${agentSegment(params.userId)}`),
		{ method: 'DELETE' }
	);
	return toNativeResponse(response as unknown as Response);
};
