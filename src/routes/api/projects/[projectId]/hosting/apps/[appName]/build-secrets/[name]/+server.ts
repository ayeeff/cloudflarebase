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
 * Operator proxy: one build secret. PUT encrypts the value at rest in the
 * hosting agent (503 until the install sets HOSTING_MASTER_KEY); DELETE drops
 * it. Values are write-only on this surface - the console never reads one
 * back, and the runner's copy travels the OIDC build-env route instead.
 */

const targetFor = (
	origin: string,
	projectId: string,
	appName: string,
	name: string
): { entry: typeof AGENT_REGISTRY.hosting; target: string } => {
	const entry = AGENT_REGISTRY.hosting;
	return {
		entry,
		target: agentUrl(
			origin,
			entry,
			projectId,
			`/apps/${agentSegment(appName)}/build-secrets/${agentSegment(name)}`
		)
	};
};

export const PUT: RequestHandler = async ({ params, request, url, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const { entry, target } = targetFor(url.origin, projectId, params.appName, params.name);
	const agent = requireAgent(platform, entry);
	const response = await agent.fetch(target, {
		method: 'PUT',
		headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
		body: await request.arrayBuffer()
	});
	return toNativeResponse(response as unknown as Response);
};

export const DELETE: RequestHandler = async ({ params, url, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const { entry, target } = targetFor(url.origin, projectId, params.appName, params.name);
	const agent = requireAgent(platform, entry);
	const response = await agent.fetch(target, { method: 'DELETE' });
	return toNativeResponse(response as unknown as Response);
};
