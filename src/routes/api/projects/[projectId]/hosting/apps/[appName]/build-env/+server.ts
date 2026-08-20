import { AGENT_REGISTRY } from '$lib/agent-registry';
import {
	agentSegment,
	agentUrl,
	assertProjectId,
	requireAgent,
	toNativeResponse
} from '$lib/server/agents';
import type { RequestHandler } from './$types';

/**
 * The build-env read, two personas:
 *
 * - **GitHub Actions OIDC** (`locals.githubDeploy`): the runner fetching the
 *   env it exports before the build step. Answers the DECRYPTED bundle over
 *   the agent's service-binding-only /internal route. The grant names exactly
 *   one connection, and that connection's app is the only build env the token
 *   may read - an ordinary 404 otherwise, indistinguishable from absence.
 *   Build env is connection-scoped: branch builds read the ROOT project's
 *   store (`grant.projectId` IS the root).
 * - **Operator session** (the guard's default): the settings UI's read -
 *   vars with values, secret NAMES only, never a decrypted value.
 */
export const GET: RequestHandler = async ({ params, url, platform, locals }) => {
	const projectId = assertProjectId(params.projectId);
	const entry = AGENT_REGISTRY.hosting;
	const agent = requireAgent(platform, entry);

	const grant = locals.githubDeploy;
	if (grant) {
		if (grant.appName !== params.appName) {
			return Response.json({ error: 'not found' }, { status: 404 });
		}
		// Synthetic host: the internal route sits outside /agents/* on purpose,
		// reachable only over the service binding (the erase-route precedent).
		const response = await agent.fetch(
			`https://${entry.manifest.worker}/internal/projects/${encodeURIComponent(grant.projectId)}/apps/${encodeURIComponent(grant.appName)}/build-env`
		);
		return toNativeResponse(response as unknown as Response);
	}

	const target = agentUrl(
		url.origin,
		entry,
		projectId,
		`/apps/${agentSegment(params.appName)}/build-env`
	);
	const response = await agent.fetch(target);
	return toNativeResponse(response as unknown as Response);
};
