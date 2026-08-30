import { serverError } from '$lib/server/agents';
import { fail } from '@sveltejs/kit';
import { geoAstroFetch } from '$lib/server/geo-astro';
import type { PageServerLoad, Actions } from './$types';

const GEO_ASTRO_BASE = 'https://geo-astro-site.foodstarmelbourne.workers.dev';

export const load: PageServerLoad = async ({ platform }) => {
	// geoAstroFetch attaches the shared x-admin-key automatically; ?all=1 on
	// /api/webring is admin-gated and lists every ring across the three indexes.
	const res = await geoAstroFetch(platform, '/api/webring?all=1');
	if (!res.ok) serverError(502, `geo-astro-site /api/webring responded ${res.status}`);
	const json: any = await res.json();
	return { rings: json.rings ?? [], count: json.count ?? 0, base: GEO_ASTRO_BASE };
};

export const actions: Actions = {
	delete: async ({ request, platform }) => {
		const form = await request.formData();
		const uuid = String(form.get('uuid') ?? '');
		if (!uuid) return fail(400, { error: 'uuid required' });
		const res = await geoAstroFetch(platform, '/api/webring', {
			method: 'POST',
			body: JSON.stringify({ action: 'remove-ring', uuid })
		});
		if (!res.ok) {
			let msg = `geo-astro-site responded ${res.status}`;
			try {
				msg = ((await res.json()) as any).error ?? msg;
			} catch {}
			return fail(res.status, { error: msg, uuid });
		}
		return { success: true };
	},
	backfillNames: async ({ platform }) => {
		const res = await geoAstroFetch(platform, '/api/webring', {
			method: 'POST',
			body: JSON.stringify({ action: 'backfill-names' })
		});
		if (!res.ok) {
			let msg = `geo-astro-site responded ${res.status}`;
			try {
				msg = ((await res.json()) as any).error ?? msg;
			} catch {}
			return fail(res.status, { error: msg });
		}
		return { success: true };
	}
};
