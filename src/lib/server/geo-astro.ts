// src/lib/server/geo-astro.ts
//
// Server-side helper for the cloudflarebase admin console to reach the
// geo-astro-site Worker. We use a SERVICE BINDING (GEO_ASTRO) rather than an
// HTTP fetch to `*.workers.dev`, because Cloudflare's edge blocks Worker→Worker
// subrequests on workers.dev (and Bot Fight Mode challenges them), which showed
// up as 502s on every /admin/* page. The binding is direct Worker-to-Worker and
// bypasses the public edge.

// Forward a request to geo-astro-site over the service binding. `path` is the
// absolute path + query (e.g. "/api/admin/content?action=list&type=article").
// The shared admin secret is attached automatically when present.
export async function geoAstroFetch(
	platform: any,
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	const binding = platform?.env?.GEO_ASTRO;
	if (!binding) {
		throw new Error('GEO_ASTRO service binding is not configured on this deployment.');
	}
	const secret = platform?.env?.ADMIN_SECRET;
	const url = new URL(path, 'https://geo-astro-site');
	const headers = new Headers(init.headers);
	if (secret && !headers.has('x-admin-key')) headers.set('x-admin-key', secret);
	return binding.fetch(new Request(url, { ...init, headers }));
}
