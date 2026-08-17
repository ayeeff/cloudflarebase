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
 * Operator/service-key proxy: mint signed download URLs for a bucket.
 *
 * JSON in, JSON out - no bytes here, so the buffering rule the sibling object
 * proxy breaks does not apply. The admin mirror mints with access modes
 * bypassed, which is what lets the console preview a private object and a
 * server-side job hand a browser a URL for one.
 *
 * The URLs it returns point at the agent's own byte path (or
 * `STORAGE_SERVE_DOMAIN` when configured), never back through here: they are
 * meant to be fetched with no credential at all.
 */
export const POST: RequestHandler = async ({ params, request, url, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const entry = AGENT_REGISTRY.storage;
	const agent = requireAgent(platform, entry);
	const target = agentUrl(
		url.origin,
		entry,
		projectId,
		`/admin/buckets/${agentSegment(params.bucketName)}/signed-urls`
	);
	const response = await agent.fetch(target, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: await request.arrayBuffer()
	});
	return toNativeResponse(response as unknown as Response);
};
