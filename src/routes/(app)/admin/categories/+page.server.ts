import { redirect } from '@sveltejs/kit';
import { fail } from '@sveltejs/kit';
import { geoAstroFetch } from '$lib/server/geo-astro';
import type { PageServerLoad, Actions } from './$types';

const GEO_ASTRO_BASE = 'https://geo-astro-site.foodstarmelbourne.workers.dev';

export const load: PageServerLoad = () => {
	throw redirect(307, '/dashboard/geo-site/content/categories');
};

export const actions: Actions = {
	edit: async ({ request, platform }) => {
		const adminKey = platform?.env?.ADMIN_SECRET;
		const authHeaders = {
			'content-type': 'application/json',
			...(adminKey ? { 'x-admin-key': adminKey } : {})
		};
		const form = await request.formData();
		const uuid = String(form.get('uuid') ?? '');
		const newGroup = form.get('newGroup') ? String(form.get('newGroup')) : undefined;
		const newLabel = form.get('newLabel') ? String(form.get('newLabel')) : undefined;
		if (!uuid) return fail(400, { error: 'uuid required' });
		const res = await geoAstroFetch(platform, '/api/catmanager', {
			method: 'POST',
			headers: authHeaders,
			body: JSON.stringify({ action: 'edit', uuid, newGroup, newLabel })
		});
		if (!res.ok) {
			let msg = `geo-astro-site responded ${res.status}`;
			try {
				msg = ((await res.json()) as { error?: string }).error ?? msg;
			} catch {}
			return fail(res.status, { error: msg, uuid });
		}
		return { success: true };
	},
	delete: async ({ request, platform }) => {
		const adminKey = platform?.env?.ADMIN_SECRET;
		const authHeaders = {
			'content-type': 'application/json',
			...(adminKey ? { 'x-admin-key': adminKey } : {})
		};
		const form = await request.formData();
		const uuid = String(form.get('uuid') ?? '');
		if (!uuid) return fail(400, { error: 'uuid required' });
		const res = await geoAstroFetch(platform, '/api/catmanager', {
			method: 'POST',
			headers: authHeaders,
			body: JSON.stringify({ action: 'delete', uuid })
		});
		if (!res.ok) {
			let msg = `geo-astro-site responded ${res.status}`;
			try {
				msg = ((await res.json()) as { error?: string }).error ?? msg;
			} catch {}
			return fail(res.status, { error: msg, uuid });
		}
		return { success: true };
	},
	add: async ({ request, platform }) => {
		const adminKey = platform?.env?.ADMIN_SECRET;
		const authHeaders = {
			'content-type': 'application/json',
			...(adminKey ? { 'x-admin-key': adminKey } : {})
		};
		const form = await request.formData();
		const input = String(form.get('input') ?? '');
		if (!input.trim()) return fail(400, { error: 'batch input required' });
		const res = await geoAstroFetch(platform, '/api/addcat', {
			method: 'POST',
			headers: authHeaders,
			body: JSON.stringify({ action: 'add', input })
		});
		if (!res.ok) {
			let msg = `geo-astro-site responded ${res.status}`;
			try {
				msg = ((await res.json()) as { error?: string }).error ?? msg;
			} catch {}
			return fail(res.status, { error: msg });
		}
		return { success: true };
	}
};
