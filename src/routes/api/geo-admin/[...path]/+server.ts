// src/routes/api/geo-admin/[...path]/+server.ts
//
// Same-origin proxy so the BROWSER (client-side) admin UI can reach
// geo-astro-site's admin APIs without CORS or exposing the admin secret.
// The server already has the GEO_ASTRO service binding + ADMIN_SECRET, so the
// proxy attaches the secret and forwards the request over the binding.
//
// Example:  POST /api/geo-admin/api/admin/articles  { action: "delete", slug }
//        →  GEO_ASTRO fetch /api/admin/articles     { action: "delete", slug }
//           (with x-admin-key: <ADMIN_SECRET>)

import { geoAstroFetch } from '$lib/server/geo-astro';
import type { RequestHandler } from './$types';

async function forward({ request, url, platform }: { request: Request; url: URL; platform: any }): Promise<Response> {
	const path = url.pathname.replace(/^\/api\/geo-admin/, '') + url.search;
	const secret = platform?.env?.ADMIN_SECRET;
	const headers = new Headers(request.headers);
	if (secret) headers.set('x-admin-key', secret);
	const body =
		request.method === 'GET' || request.method === 'HEAD'
			? undefined
			: await request.text().catch(() => undefined);
	try {
		const res = await geoAstroFetch(platform, path, {
			method: request.method,
			headers,
			body,
		});
		return new Response(res.body, {
			status: res.status,
			headers: res.headers,
		});
	} catch (e: any) {
		return new Response(JSON.stringify({ error: e?.message ?? 'geo-astro proxy failed' }), {
			status: 502,
			headers: { 'content-type': 'application/json' },
		});
	}
}

export const GET: RequestHandler = ({ request, url, platform }) => forward({ request, url, platform });
export const POST: RequestHandler = ({ request, url, platform }) => forward({ request, url, platform });
export const PUT: RequestHandler = ({ request, url, platform }) => forward({ request, url, platform });
export const DELETE: RequestHandler = ({ request, url, platform }) => forward({ request, url, platform });
