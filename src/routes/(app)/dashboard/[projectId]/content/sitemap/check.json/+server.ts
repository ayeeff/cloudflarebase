// Batched status probe for the sitemap dashboard. The browser slices the URL
// list it already has (from the page load) into chunks of <=25 and POSTs each
// chunk here; probing is opt-in because 1440 URLs cannot fit inside one
// request's subrequest budget on the free tier.
//
// Endpoints do not run layout server loads, so the ADMIN_SECRET session gate
// from content/+layout.server.ts is re-enforced here by hand.

import { json } from '@sveltejs/kit';
import { geoAstroFetch } from '$lib/server/geo-astro';
import { sha256Hex, COOKIE } from '$lib/server/admin-session';
import type { RequestHandler } from './$types';

const BATCH_CAP = 25;

export const POST: RequestHandler = async ({ request, cookies, platform }) => {
	const secret = platform?.env?.ADMIN_SECRET;
	if (!secret) return json({ error: 'ADMIN_SECRET not configured' }, { status: 503 });
	const expected = await sha256Hex(secret);
	if (cookies.get(COOKIE) !== expected) {
		return json({ error: 'unauthorized' }, { status: 401 });
	}

	let urls: unknown;
	try {
		const body: unknown = await request.json();
		urls = (body as { urls?: unknown })?.urls;
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}
	if (!Array.isArray(urls) || urls.length === 0 || urls.length > BATCH_CAP) {
		return json(
			{ error: `urls must be a non-empty array of at most ${BATCH_CAP}` },
			{ status: 400 }
		);
	}

	const statuses = await Promise.all(
		(urls as unknown[]).map(async (raw): Promise<{ loc: string; status: number }> => {
			if (typeof raw !== 'string') return { loc: String(raw), status: 0 };
			let target: URL;
			try {
				target = new URL(raw);
			} catch {
				return { loc: raw, status: 0 };
			}
			if (target.protocol !== 'https:' && target.protocol !== 'http:') {
				return { loc: raw, status: 0 };
			}
			try {
				// Route through the service binding, not the public edge.
				const res = await geoAstroFetch(platform, target.pathname + target.search, {
					method: 'GET',
					headers: { 'user-agent': 'cloudflarebase-sitemap-check' },
					signal: AbortSignal.timeout(15000)
				});
				await res.body?.cancel(); // drain so workerd never wedges
				return { loc: raw, status: res.status };
			} catch {
				return { loc: raw, status: 0 };
			}
		})
	);

	return json({ statuses });
};
