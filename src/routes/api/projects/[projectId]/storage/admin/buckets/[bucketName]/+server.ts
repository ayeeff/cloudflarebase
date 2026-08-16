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
 * Operator proxy: one bucket's config - read, create/update, delete. JSON
 * only; object BYTES never transit this proxy (its handlers buffer bodies) -
 * they take the `/agents/*` passthrough to the worker's streaming path.
 */
const proxy = (method: string): RequestHandler => {
	return async ({ params, request, url, platform }) => {
		const projectId = assertProjectId(params.projectId);
		const entry = AGENT_REGISTRY.storage;
		const agent = requireAgent(platform, entry);
		const target = agentUrl(
			url.origin,
			entry,
			projectId,
			`/admin/buckets/${agentSegment(params.bucketName)}`
		);
		const response = await agent.fetch(target, {
			method,
			headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
			body: method === 'PUT' ? await request.arrayBuffer() : undefined
		});
		return toNativeResponse(response as unknown as Response);
	};
};

export const GET = proxy('GET');
export const PUT = proxy('PUT');
export const DELETE = proxy('DELETE');
