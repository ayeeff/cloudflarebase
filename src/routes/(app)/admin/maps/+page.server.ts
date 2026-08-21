import { serverError } from '$lib/server/agents';
import { fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';

const GEO_ASTRO_BASE = 'https://geo-astro-site.foodstarmelbourne.workers.dev';

export const load: PageServerLoad = async ({ fetch, platform }) => {
	const adminKey = platform?.env?.ADMIN_SECRET;
	const headers = { 'content-type': 'application/json', ...(adminKey ? { 'x-admin-key': adminKey } : {}) };

	const [mapsRes, deniedRes] = await Promise.all([
		fetch(`${GEO_ASTRO_BASE}/api/adminpanel`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ action: 'list-maps' })
		}),
		fetch(`${GEO_ASTRO_BASE}/api/admin/maps`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ action: 'list' })
		})
	]);

	if (!mapsRes.ok) serverError(502, `geo-astro-site /api/adminpanel responded ${mapsRes.status}`);
	const mapsData = await mapsRes.json();
	let denied: any[] = [];
	if (deniedRes.ok) {
		const d = await deniedRes.json();
		denied = d.denied ?? [];
	}
	const deniedKeys = new Set(denied.map((d: any) => d.key));

	const maps = (mapsData.maps ?? []).map((m: any) => {
		const key = m.uuid ? `${m.uuid}/${m.slug}` : m.slug;
		return { ...m, pathKey: key, denied: deniedKeys.has(key) };
	});

	return {
		maps,
		count: mapsData.count ?? 0,
		denied,
		deniedCount: denied.length,
		base: GEO_ASTRO_BASE
	};
};

export const actions: Actions = {
	delete: async ({ request, fetch, platform }) => {
		const adminKey = platform?.env?.ADMIN_SECRET;
		const form = await request.formData();
		const slug = String(form.get('slug') ?? '');
		const uuid = form.get('uuid') ? String(form.get('uuid')) : undefined;
		if (!slug) return fail(400, { error: 'slug required' });
		const res = await fetch(`${GEO_ASTRO_BASE}/api/admin/maps`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...(adminKey ? { 'x-admin-key': adminKey } : {}) },
			body: JSON.stringify({ action: 'delete', slug, uuid })
		});
		if (!res.ok) return fail(res.status, { error: `geo-astro-site responded ${res.status}` });
		return { success: true };
	},
	restore: async ({ request, fetch, platform }) => {
		const adminKey = platform?.env?.ADMIN_SECRET;
		const form = await request.formData();
		const slug = String(form.get('slug') ?? '');
		const uuid = form.get('uuid') ? String(form.get('uuid')) : undefined;
		if (!slug) return fail(400, { error: 'slug required' });
		const res = await fetch(`${GEO_ASTRO_BASE}/api/admin/maps`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...(adminKey ? { 'x-admin-key': adminKey } : {}) },
			body: JSON.stringify({ action: 'restore', slug, uuid })
		});
		if (!res.ok) return fail(res.status, { error: `geo-astro-site responded ${res.status}` });
		return { success: true };
	}
};
