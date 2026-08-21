import { serverError } from '$lib/server/agents';
import { fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';

const GEO_ASTRO_BASE = 'https://geo-astro-site.foodstarmelbourne.workers.dev';

export const load: PageServerLoad = async ({ fetch, platform }) => {
	const adminKey = platform?.env?.ADMIN_SECRET;
	const authHeaders = {
		'content-type': 'application/json',
		...(adminKey ? { 'x-admin-key': adminKey } : {})
	};
	const res = await fetch(`${GEO_ASTRO_BASE}/api/catmanager?action=list`, { headers: authHeaders });
	if (!res.ok) serverError(502, `geo-astro-site /api/catmanager responded ${res.status}`);
	const json: any = await res.json();
	return { categories: json.categories ?? [], count: json.count ?? 0, base: GEO_ASTRO_BASE };
};

export const actions: Actions = {
	edit: async ({ request, fetch, platform }) => {
		const adminKey = platform?.env?.ADMIN_SECRET;
		const form = await request.formData();
		const uuid = String(form.get('uuid') ?? '');
		const newGroup = form.get('newGroup') ? String(form.get('newGroup')) : undefined;
		const newLabel = form.get('newLabel') ? String(form.get('newLabel')) : undefined;
		if (!uuid) return fail(400, { error: 'uuid required' });
		const res = await fetch(`${GEO_ASTRO_BASE}/api/catmanager`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...(adminKey ? { 'x-admin-key': adminKey } : {}) },
			body: JSON.stringify({ action: 'edit', uuid, newGroup, newLabel })
		});
		if (!res.ok) {
			let msg = `geo-astro-site responded ${res.status}`;
			try {
				msg = (await res.json()).error ?? msg;
			} catch {}
			return fail(res.status, { error: msg, uuid });
		}
		return { success: true };
	},
	delete: async ({ request, fetch, platform }) => {
		const adminKey = platform?.env?.ADMIN_SECRET;
		const form = await request.formData();
		const uuid = String(form.get('uuid') ?? '');
		if (!uuid) return fail(400, { error: 'uuid required' });
		const res = await fetch(`${GEO_ASTRO_BASE}/api/catmanager`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...(adminKey ? { 'x-admin-key': adminKey } : {}) },
			body: JSON.stringify({ action: 'delete', uuid })
		});
		if (!res.ok) {
			let msg = `geo-astro-site responded ${res.status}`;
			try {
				msg = (await res.json()).error ?? msg;
			} catch {}
			return fail(res.status, { error: msg, uuid });
		}
		return { success: true };
	},
	add: async ({ request, fetch, platform }) => {
		const adminKey = platform?.env?.ADMIN_SECRET;
		const form = await request.formData();
		const input = String(form.get('input') ?? '');
		if (!input.trim()) return fail(400, { error: 'batch input required' });
		const res = await fetch(`${GEO_ASTRO_BASE}/api/addcat`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...(adminKey ? { 'x-admin-key': adminKey } : {}) },
			body: JSON.stringify({ action: 'add', input })
		});
		if (!res.ok) {
			let msg = `geo-astro-site responded ${res.status}`;
			try {
				msg = (await res.json()).error ?? msg;
			} catch {}
			return fail(res.status, { error: msg });
		}
		return { success: true };
	}
};
