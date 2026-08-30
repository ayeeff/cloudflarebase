import { serverError } from '$lib/server/agents';
import { fail } from '@sveltejs/kit';
import { geoAstroFetch } from '$lib/server/geo-astro';
import type { PageServerLoad, Actions } from './$types';

const GEO_ASTRO_BASE = 'https://geo-astro-site.foodstarmelbourne.workers.dev';

// Atlas pages are the flat *-atlas pages that moved from src/pages/maps/ to
// src/pages/atlas/ — served at /atlas/<slug>. They are build-time pages (no
// R2 backing), so: listing comes from the build-time map index, hiding uses
// the map denylist (worker.ts 404s denied /atlas/<slug>), and permanent
// deletion needs filesystem access (dev checkout only).
function isAtlasEntry(m: any): boolean {
	if (!/-atlas$/i.test(String(m?.slug ?? ''))) return false;
	return !(m.categoryUuid ?? m.uuid ?? null);
}

export const load: PageServerLoad = async ({ platform }) => {
	const adminKey = platform?.env?.ADMIN_SECRET;
	const authHeaders = {
		'content-type': 'application/json',
		...(adminKey ? { 'x-admin-key': adminKey } : {})
	};

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
		const d: any = await deniedRes.json();
		denied = d.denied ?? [];
	}
	// Atlas pages are flat — their denylist key is the bare slug.
	const deniedKeys = new Set(denied.filter((d: any) => !d.uuid).map((d: any) => d.slug));

	const stats: any = statsRes.ok
		? await statsRes.json()
		: { likes: {}, comments: {}, saves: {}, views: {} };

	const maps = rawMaps
		.filter(isAtlasEntry)
		.map((m: any) => {
			const s = m.slug;
			const screenshotUrl = m.screenshot ? `${GEO_ASTRO_BASE}${m.screenshot}` : null;
			return {
				slug: m.slug,
				title: m.title || m.slug,
				uuid: null,
				type: m.type || 'atlas',
				screenshotUrl,
				hasScreenshot: !!m.screenshot,
				pathKey: m.slug,
				denied: deniedKeys.has(m.slug),
				views: typeof stats.views?.[s] === 'number' ? stats.views[s] : Number(stats.views?.[s] ?? 0) || 0,
				likes: typeof stats.likes?.[s] === 'number' ? stats.likes[s] : Number(stats.likes?.[s] ?? 0) || 0,
				comments: typeof stats.comments?.[s] === 'number' ? stats.comments[s] : Number(stats.comments?.[s] ?? 0) || 0
			};
		});

	return {
		maps,
		count: maps.length,
		denied: denied.filter((d: any) => !d.uuid),
		deniedCount: denied.filter((d: any) => !d.uuid).length,
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
		if (!slug) return fail(400, { error: 'slug required' });
		const res = await geoAstroFetch(platform, '/api/admin/maps', {
			method: 'POST',
			headers: authHeaders,
			body: JSON.stringify({ action: 'delete', slug, reason: 'atlas-dashboard' })
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
		if (!slug) return fail(400, { error: 'slug required' });
		const res = await geoAstroFetch(platform, '/api/admin/maps', {
			method: 'POST',
			headers: authHeaders,
			body: JSON.stringify({ action: 'restore', slug })
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
		if (!slug) return fail(400, { error: 'slug required' });
		const res = await geoAstroFetch(platform, '/api/admin/panel', {
			method: 'POST',
			headers: authHeaders,
			body: JSON.stringify({ action: 'delete-map', slug })
		});
		if (!res.ok) {
			const err = (await res.json().catch(() => null)) as any;
			return fail(res.status, { error: err?.error ?? `geo-astro-site responded ${res.status}` });
		}
		return { success: true };
	}
};
