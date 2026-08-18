import { agentSegment } from '$lib/server/agents';
import {
	agentUrl,
	assertProjectId,
	requireAuthAgent,
	toNativeResponse
} from '$lib/server/auth-agent';
import type { RequestHandler } from './$types';

/**
 * Set an account's password without an emailed token
 * (docs/admin-sdk-design.md 5.2) - migrations off another provider and support
 * flows both need it, and Better Auth's `request-password-reset` cannot serve
 * either (it requires the user's own mailbox).
 *
 * Sessions are revoked by default: setting a password is how an account is
 * recovered AND how one is stolen, so the safe outcome is the one you get
 * without asking. The agent enforces the bounds and the default.
 *
 * Operator-only by the guard, like every other `/admin/*` route. Deliberately
 * a sibling of `/role` rather than part of the general user PATCH, so the two
 * most dangerous writes on an account each need their own deliberate call.
 */
export const PUT: RequestHandler = async ({ params, request, url, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const agent = requireAuthAgent(platform);
	const response = await agent.fetch(
		agentUrl(url.origin, projectId, `/admin/users/${agentSegment(params.userId)}/password`),
		{
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: await request.arrayBuffer()
		}
	);
	return toNativeResponse(response as unknown as Response);
};
