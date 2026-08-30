import { serverError } from '$lib/server/agents';
import { fail } from '@sveltejs/kit';
import { geoAstroFetch } from '$lib/server/geo-astro';
import type { PageServerLoad, Actions } from './$types';

const GEO_ASTRO_BASE = 'https://geo-astro-site.foodstarmelbourne.workers.dev';

async function callCollectionsApi(platform: any, body: Record<string, any>): Promise<Response> {
	return geoAstroFetch(platform, '/api/admin/collections', {
		method: 'POST',
		body: JSON.stringify(body)
	});
}

async function apiError(res: Response): Promise<string> {
	let msg = `geo-astro-site responded ${res.status}`;
	try {
		msg = ((await res.json()) as any).error ?? msg;
	} catch {}
	return msg;
}

export const load: PageServerLoad = async ({ platform }) => {
	const [collRes, indexRes] = await Promise.all([
		geoAstroFetch(platform, '/api/admin/collections'),
		geoAstroFetch(platform, '/api/map-index.json')
	]);
	if (!collRes.ok) serverError(502, `geo-astro-site /api/admin/collections responded ${collRes.status}`);
	const coll: any = await collRes.json();

	// Picker entries — every deployed map + atlas page that can be added to a
	// collection. Atlas pages have no categoryUuid/uuid in the index.
	let picker: { slug: string; title: string; isAtlas: boolean }[] = [];
	if (indexRes.ok) {
		const idx: any = await indexRes.json();
		const maps = Array.isArray(idx) ? idx : (idx.maps ?? []);
		picker = maps
			.filter((m: any) => m?.slug)
			.map((m: any) => ({
				slug: m.slug,
				title: m.title ?? m.slug,
				isAtlas: !(m.categoryUuid ?? m.uuid ?? null)
			}))
			.sort((a: any, b: any) => a.slug.localeCompare(b.slug));
	}

	return {
		collections: coll.collections ?? {},
		counts: coll.counts ?? {},
		labels: coll.labels ?? Object.keys(coll.collections ?? {}),
		overridden: coll.overridden ?? false,
		picker,
		base: GEO_ASTRO_BASE
	};
};

export const actions: Actions = {
	add: async ({ request, platform }) => {
		const form = await request.formData();
		const collection = String(form.get('collection') ?? '');
		const slug = String(form.get('slug') ?? '').trim();
		if (!collection || !slug) return fail(400, { error: 'collection and slug required' });
		const res = await callCollectionsApi(platform, {
			action: 'add',
			collection,
			slug,
			name: form.get('name') ? String(form.get('name')) : undefined,
			iata: form.get('iata') ? String(form.get('iata')).toUpperCase() : undefined
		});
		if (!res.ok) return fail(res.status, { error: await apiError(res) });
		return { success: true };
	},
	remove: async ({ request, platform }) => {
		const form = await request.formData();
		const collection = String(form.get('collection') ?? '');
		const slug = String(form.get('slug') ?? '');
		if (!collection || !slug) return fail(400, { error: 'collection and slug required' });
		const res = await callCollectionsApi(platform, { action: 'remove', collection, slug });
		if (!res.ok) return fail(res.status, { error: await apiError(res) });
		return { success: true };
	},
	edit: async ({ request, platform }) => {
		const form = await request.formData();
		const collection = String(form.get('collection') ?? '');
		const slug = String(form.get('slug') ?? '');
		if (!collection || !slug) return fail(400, { error: 'collection and slug required' });
		const res = await callCollectionsApi(platform, {
			action: 'edit',
			collection,
			slug,
			name: form.get('name') ? String(form.get('name')) : undefined,
			iata: form.get('iata') ? String(form.get('iata')).toUpperCase() : undefined,
			pop: form.get('pop') ? Number(form.get('pop')) : undefined,
			continent: form.get('continent') ? String(form.get('continent')) : undefined
		});
		if (!res.ok) return fail(res.status, { error: await apiError(res) });
		return { success: true };
	},
	reset: async ({ platform }) => {
		const res = await callCollectionsApi(platform, { action: 'reset' });
		if (!res.ok) return fail(res.status, { error: await apiError(res) });
		return { success: true };
	}
};
