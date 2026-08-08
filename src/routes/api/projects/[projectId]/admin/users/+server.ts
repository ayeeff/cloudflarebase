import {
	agentUrl,
	assertProjectId,
	requireAuthAgent,
	toNativeResponse
} from '$lib/server/auth-agent';
import type { RequestHandler } from './$types';

/** One keyset page of users. `cursor` and `limit` pass straight through - the
 * cursor is opaque to the console. */
export const GET: RequestHandler = async ({ params, url, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const agent = requireAuthAgent(platform);

	const query = new URLSearchParams();
	const cursor = url.searchParams.get('cursor');
	const limit = url.searchParams.get('limit');
	if (cursor) query.set('cursor', cursor);
	if (limit) query.set('limit', limit);
	const suffix = query.size ? `?${query}` : '';

	const response = await agent.fetch(agentUrl(url.origin, projectId, `/admin/users${suffix}`));
	return toNativeResponse(response as unknown as Response);
};
