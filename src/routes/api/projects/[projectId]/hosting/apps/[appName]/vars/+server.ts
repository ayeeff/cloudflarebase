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
 * Operator proxy: an app's stored runtime vars. GET lists; PUT replaces the
 * whole set (the console form submits the full table, so absent names are
 * deletions) and best-effort patches the live script.
 */

export const GET: RequestHandler = async ({ params, url, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const entry = AGENT_REGISTRY.hosting;
	const agent = requireAgent(platform, entry);
	const target = agentUrl(
		url.origin,
		entry,
		projectId,
		`/apps/${agentSegment(params.appName)}/vars`
	);
	const response = await agent.fetch(target);
	return toNativeResponse(response as unknown as Response);
};

export const PUT: RequestHandler = async ({ params, request, url, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const entry = AGENT_REGISTRY.hosting;
	const agent = requireAgent(platform, entry);
	const target = agentUrl(
		url.origin,
		entry,
		projectId,
		`/apps/${agentSegment(params.appName)}/vars`
	);
	const response = await agent.fetch(target, {
		method: 'PUT',
		headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
		body: await request.arrayBuffer()
	});
	return toNativeResponse(response as unknown as Response);
};
