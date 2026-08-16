import { AGENT_REGISTRY } from '$lib/agent-registry';
import {
	agentProxyUrl,
	agentSegment,
	assertProjectId,
	requireAgent,
	toNativeResponse
} from '$lib/server/agents';
import type { RequestHandler } from './$types';

/**
 * Operator proxy for object BYTES: list, GET/HEAD, PUT, DELETE.
 *
 * This route deliberately did not exist until service keys did. The sibling
 * bucket-config proxy says why - "object BYTES never transit this proxy (its
 * handlers buffer bodies) - they take the `/agents/*` passthrough to the
 * worker's streaming path" - and that was right while every consumer of the
 * object surface held a SESSION: the console's upload UI and the whole e2e
 * suite both dial `/agents/storage-agent/<pid>/admin/buckets/<b>/objects/...`
 * directly.
 *
 * A `cfbs_` service key cannot. `isServiceKeySurface` matches only under
 * `/api/projects/<id>/`, so the passthrough is closed to it, and with no route
 * here a key could configure buckets but never read or write a single object -
 * storage's entire point (docs/admin-sdk-design.md 5.3).
 *
 * So the constraint the original note names has to be SOLVED rather than
 * routed around: this handler streams. `request.body` is handed to the binding
 * untouched, never `arrayBuffer()`, because the agent's whole design is that
 * bytes never enter a Durable Object, and a proxy that buffers a 100 MB PUT
 * reintroduces exactly the memory bomb its `Content-Length` requirement (411)
 * exists to prevent.
 */

/**
 * Headers the storage worker actually reads on an object request. Built
 * explicitly rather than forwarded wholesale, matching every other proxy here.
 *
 * `authorization` is deliberately NOT among them. The key was already verified
 * by the guard, the agent's admin path skips `checkAccess` entirely, and a
 * credential should not travel one hop further than the boundary that consumed
 * it. It also keeps the agent's cache-eligibility test (which treats a request
 * carrying `authorization` as uncacheable) reading the same through this door
 * as through the passthrough the console UI uses.
 */
const FORWARDED_HEADERS = [
	// PUT: content-length is REQUIRED by the agent - a chunked body is refused
	// (411) rather than buffered, so dropping it here would 411 every upload.
	'content-length',
	'content-type',
	'cache-control',
	// GET/HEAD: range and conditional requests reach R2 via `onlyIf`.
	'range',
	'if-none-match',
	'if-match',
	'if-modified-since',
	'if-unmodified-since'
];

const proxy: RequestHandler = async ({ params, request, url, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const entry = AGENT_REGISTRY.storage;
	const agent = requireAgent(platform, entry);

	// agentProxyUrl, not string interpolation: SvelteKit decodes route params,
	// so a `%2E%2E` in the key arrives as a real dot segment and the URL parser
	// would resolve it straight out of this bucket's prefix. Normalise first,
	// then require the result to still sit under it. An empty `params.key` is
	// the LIST path (`/objects`), which the agent's own route makes optional.
	const target = agentProxyUrl(
		url.origin,
		entry,
		projectId,
		`/admin/buckets/${agentSegment(params.bucketName)}/objects`,
		params.key,
		url.search
	);

	const headers: Record<string, string> = {};
	for (const name of FORWARDED_HEADERS) {
		const value = request.headers.get(name);
		if (value !== null) headers[name] = value;
	}

	const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
	const response = await agent.fetch(target, {
		method: request.method,
		headers,
		// `duplex: 'half'` is required whenever a stream is the body; without it
		// the fetch throws rather than streaming. Not in the ambient RequestInit
		// this project's types resolve, hence the cast.
		...(hasBody && request.body ? { body: request.body, duplex: 'half' } : {})
	} as RequestInit);

	return toNativeResponse(response as unknown as Response);
};

export const GET = proxy;
export const PUT = proxy;
export const DELETE = proxy;
