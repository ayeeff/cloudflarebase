import { serverError } from '$lib/server/agents';
import { fail } from '@sveltejs/kit';
import { geoAstroFetch } from '$lib/server/geo-astro';
import type { PageServerLoad, Actions } from './$types';

const GEO_ASTRO_BASE = 'https://geo-astro-site.foodstarmelbourne.workers.dev';

export const load: PageServerLoad = async ({ platform }) => {
	const adminKey = platform?.env?.ADMIN_SECRET;
	const authHeaders = {
		'content-type': 'application/json',
		...(adminKey ? { 'x-admin-key': adminKey } : {})
	};

	// Map list comes from the Worker-compatible index (build-time JSON + live R2
	// scan). We reach geo-astro-site over the GEO_ASTRO SERVICE BINDING (not an
	// HTTP fetch to *.workers.dev, which Cloudflare's edge blocks -> 502).
	const [indexRes, deniedRes, statsRes] = await Promise.all([
		geoAstroFetch(platform, '/api/map-index.json'),
		geoAstroFetch(platform, '/api/admin/maps', {
			method: 'POST',
			headers: authHeaders,
			body: JSON.stringify({ action: 'list' })
		}),
		geoAstroFetch(platform, '/api/social-stats.json', {
			headers: { 'content-type': 'application/json' }
		})
	]);

	if (!indexRes.ok) serverError(502, `geo-astro-site /api/map-index.json responded ${indexRes.status}`);
	const indexJson: any = await indexRes.json();
	const rawMaps: any[] = Array.isArray(indexJson) ? indexJson : indexJson.maps ?? [];

	let denied: any[] = [];
	if (deniedRes.ok) {
		const d = await deniedRes.json();
		denied = d.denied ?? [];
	}
	const deniedKeys = new Set(denied.map((d: any) => d.key));

	const stats: any = statsRes.ok
		? await statsRes.json()
		: { likes: {}, comments: {}, saves: {}, views: {} };

	const maps = rawMaps.map((m: any) => {
		const uuid = m.categoryUuid ?? m.uuid ?? null;
		const pathKey = uuid ? `${uuid}/${m.slug}` : m.slug;
		const screenshotUrl = m.screenshot ? `${GEO_ASTRO_BASE}${m.screenshot}` : null;
		const s = m.slug;
		return {
			slug: m.slug,
			title: m.title || m.slug,
			uuid,
			type: m.type || 'flat',
			screenshotUrl,
			hasScreenshot: !!m.screenshot,
			pathKey,
			denied: deniedKeys.has(pathKey),
			views: typeof stats.views?.[s] === 'number' ? stats.views[s] : Number(stats.views?.[s] ?? 0) || 0,
			likes: typeof stats.likes?.[s] === 'number' ? stats.likes[s] : Number(stats.likes?.[s] ?? 0) || 0,
			comments: typeof stats.comments?.[s] === 'number' ? stats.comments[s] : Number(stats.comments?.[s] ?? 0) || 0
		};
	});

	return {
		maps,
		count: maps.length,
		denied,
		deniedCount: denied.length,
		base: GEO_ASTRO_BASE
	};
};

export const actions: Actions = {
	delete: async ({ request, platform }) => {
		const adminKey = platform?.env?.ADMIN_SECRET;
		const authHeaders = {
			'content-type': 'application/json',
			...(adminKey ? { 'x-admin-key': adminKey } : {})
		};
		const form = await request.formData();
		const slug = String(form.get('slug') ?? '');
		const uuid = form.get('uuid') ? String(form.get('uuid')) : undefined;
		if (!slug) return fail(400, { error: 'slug required' });
		const res = await geoAstroFetch(platform, '/api/admin/maps', {
			method: 'POST',
			headers: authHeaders,
			body: JSON.stringify({ action: 'delete', slug, uuid })
		});
		if (!res.ok) return fail(res.status, { error: `geo-astro-site responded ${res.status}` });
		return { success: true };
	},
	restore: async ({ request, platform }) => {
		const adminKey = platform?.env?.ADMIN_SECRET;
		const authHeaders = {
			'content-type': 'application/json',
			...(adminKey ? { 'x-admin-key': adminKey } : {})
		};
		const form = await request.formData();
		const slug = String(form.get('slug') ?? '');
		const uuid = form.get('uuid') ? String(form.get('uuid')) : undefined;
		if (!slug) return fail(400, { error: 'slug required' });
		const res = await geoAstroFetch(platform, '/api/admin/maps', {
			method: 'POST',
			headers: authHeaders,
			body: JSON.stringify({ action: 'restore', slug, uuid })
		});
		if (!res.ok) return fail(res.status, { error: `geo-astro-site responded ${res.status}` });
		return { success: true };
	},
	'delete-permanent': async ({ request, platform }) => {
		const adminKey = platform?.env?.ADMIN_SECRET;
		const authHeaders = {
			'content-type': 'application/json',
			...(adminKey ? { 'x-admin-key': adminKey } : {})
		};
		const form = await request.formData();
		const slug = String(form.get('slug') ?? '');
		const uuid = form.get('uuid') ? String(form.get('uuid')) : undefined;
		if (!slug) return fail(400, { error: 'slug required' });
		const res = await geoAstroFetch(platform, '/api/adminpanel', {
			method: 'POST',
			headers: authHeaders,
			body: JSON.stringify({ action: 'delete-map', slug, categoryUuid: uuid })
		});
		if (!res.ok) {
			const err = (await res.json().catch(() => null)) as any;
			return fail(res.status, { error: err?.error ?? `geo-astro-site responded ${res.status}` });
		}
		return { success: true };
	}
};
