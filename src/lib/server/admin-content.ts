import { serverError } from '$lib/server/agents';
import { fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from '@sveltejs/kit';

const GEO_ASTRO_BASE = 'https://geo-astro-site.foodstarmelbourne.workers.dev';

export type ContentType = 'article' | 'blog' | 'write';

function deniedKeyFor(type: ContentType, e: any): string {
	if (type === 'article') return e.slug;
	return e.uuid ? `${e.uuid}/${e.slug}` : e.slug;
}

export function buildContentLoad(type: ContentType, deniedEndpoint: string): PageServerLoad {
	return async ({ fetch, platform }) => {
		const adminKey = platform?.env?.ADMIN_SECRET;
		const authHeaders = {
			'content-type': 'application/json',
			...(adminKey ? { 'x-admin-key': adminKey } : {})
		};

		const [listRes, deniedRes] = await Promise.all([
			fetch(`${GEO_ASTRO_BASE}/api/admin/content?action=list&type=${type}`, { headers: authHeaders }),
			fetch(`${GEO_ASTRO_BASE}${deniedEndpoint}`, {
				method: 'POST',
				headers: authHeaders,
				body: JSON.stringify({ action: 'list' })
			})
		]);

		if (!listRes.ok) serverError(502, `geo-astro-site /api/admin/content responded ${listRes.status}`);
		const listJson: any = await listRes.json();
		const entries: any[] = Array.isArray(listJson) ? listJson : listJson.entries ?? [];

		let denied: any[] = [];
		if (deniedRes.ok) denied = (await deniedRes.json()).denied ?? [];

		const deniedSet = new Set(
			denied.map((d: any) => (type === 'article' ? d.slug : (d.key ?? `${d.uuid ?? ''}/${d.slug}`)))
		);

		const rows = entries.map((e: any) => {
			const pathKey = deniedKeyFor(type, e);
			return {
				slug: e.slug,
				title: e.title || e.slug,
				uuid: type === 'article' ? null : (e.uuid ?? null),
				url: e.url,
				pathKey,
				denied: deniedSet.has(pathKey)
			};
		});

		return {
			type,
			rows,
			denied,
			count: rows.length,
			deniedCount: denied.length,
			base: GEO_ASTRO_BASE
		};
	};
}

export function buildContentActions(deniedEndpoint: string): Actions {
	async function run(action: 'delete' | 'restore', request: Request, fetchFn: any, platform: any) {
		const adminKey = platform?.env?.ADMIN_SECRET;
		const form = await request.formData();
		const slug = String(form.get('slug') ?? '');
		const uuid = form.get('uuid') ? String(form.get('uuid')) : undefined;
		if (!slug) return fail(400, { error: 'slug required' });
		const res = await fetchFn(`${GEO_ASTRO_BASE}${deniedEndpoint}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...(adminKey ? { 'x-admin-key': adminKey } : {}) },
			body: JSON.stringify({ action, slug, uuid })
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
	return {
		delete: ({ request, fetch, platform }) => run('delete', request, fetch, platform),
		restore: ({ request, fetch, platform }) => run('restore', request, fetch, platform)
	};
}
