import { json } from '@sveltejs/kit';
import { assertProjectId } from '$lib/server/agents';
import { revokeServiceKey } from '$lib/server/service-keys';
import type { RequestHandler } from './$types';

/** Revocation IS row deletion. Verified keys stay cached per isolate for up to
 * their TTL (30s), which is the documented bargain - see service-keys.ts. */
export const DELETE: RequestHandler = async ({ params, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const revoked = await revokeServiceKey(platform, projectId, params.keyId);
	if (!revoked) return json({ error: 'no such service key' }, { status: 404 });
	return json({ revoked: true });
};
