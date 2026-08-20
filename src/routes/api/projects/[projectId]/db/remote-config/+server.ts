import { AGENT_REGISTRY } from '$lib/agent-registry';
import { agentUrl, assertProjectId, requireAgent, toNativeResponse } from '$lib/server/agents';
import type { RequestHandler } from './$types';

/**
 * Public passthrough for Remote Config's evaluated endpoint.
 *
 * The one thing this handler does beyond forwarding is resolve the caller's
 * COUNTRY, and it is security-relevant twice over:
 *
 * 1. A service-binding fetch keeps none of the original request's Cloudflare
 *    properties, so `request.cf` is gone by the time the agent sees it. Country
 *    has to be carried explicitly or every country rule silently stops
 *    matching - the same reason the collections proxy forwards it for
 *    analytics.
 * 2. The header is therefore an INPUT the agent trusts, so a client must never
 *    be able to set it. It is deleted unconditionally and re-set only from the
 *    edge-resolved value: overwriting only `if (country)` would leave a
 *    spoofed header standing whenever Cloudflare resolved no country, which is
 *    exactly when an attacker would try.
 */
const proxy: RequestHandler = async ({ params, request, url, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const entry = AGENT_REGISTRY.db;
	const agent = requireAgent(platform, entry);

	const target = agentUrl(url.origin, entry, projectId, `/remote-config${url.search}`);

	const headers = new Headers(request.headers);
	headers.delete('cf-ipcountry');
	const country = (request as Request & { cf?: { country?: string } }).cf?.country;
	if (country) headers.set('cf-ipcountry', country);

	// url + init, never a Request: in dev the binding is a miniflare proxy that
	// cannot consume Requests from the Node realm.
	const response = await agent.fetch(target, { method: request.method, headers: [...headers] });
	return toNativeResponse(response as unknown as Response);
};

export const GET = proxy;
export const OPTIONS = proxy;
