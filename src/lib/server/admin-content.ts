// src/lib/server/admin-content.ts
//
// Shared load + action builders for the content-management admin pages
// (/admin/maps already has its own; /admin/articles, /admin/blog, /admin/write
// use these). They talk to geo-astro-site's Worker-compatible admin APIs over a
// SERVICE BINDING (GEO_ASTRO) — never a relative fetch, which would resolve to
// the cloudflarebase origin and 404, and never an absolute workers.dev HTTP
// fetch, which Cloudflare's edge blocks (502).

import { geoAstroFetch } from '$lib/server/geo-astro';
import type { ContentType } from '$lib/types/admin';

const ADMIN_API = '/api/admin';
const GEO_ASTRO_BASE = 'https://geo-astro-site.foodstarmelbourne.workers.dev';

// geo-astro-site stores the denylist under /api/admin/<kind> (articles | blog |
// write | maps). The content listing lives under /api/admin/content?type=.
const KIND: Record<ContentType, string> = {
	article: 'articles',
	blog: 'blog',
	write: 'write'
};

function deniedKeyFor(type: ContentType, e: any): string {
	if (type === 'article') return e.slug;
	return e.uuid ? `${e.uuid}/${e.slug}` : e.slug;
}

export async function buildContentLoad(event: any, type: ContentType) {
	const adminKey = event.platform?.env?.ADMIN_SECRET;
	const authHeaders: Record<string, string> = { 'content-type': 'application/json' };
	if (adminKey) authHeaders['x-admin-key'] = adminKey;
	const kind = KIND[type];

	const [listRes, deniedRes, statsRes] = await Promise.all([
		geoAstroFetch(event.platform, `${ADMIN_API}/content?action=list&type=${type}`, {
			headers: { 'content-type': 'application/json' }
		}),
		geoAstroFetch(event.platform, `${ADMIN_API}/${kind}`, {
			method: 'POST',
			headers: authHeaders,
			body: JSON.stringify({ action: 'list' })
		}),
		geoAstroFetch(event.platform, '/api/social-stats.json', {
			headers: { 'content-type': 'application/json' }
		})
	]);

	const entries: any[] = listRes.ok ? (((await listRes.json()) as any).entries ?? []) : [];
	const deniedList: any[] = deniedRes.ok ? (((await deniedRes.json()) as any).denied ?? []) : [];
	const stats: any = statsRes.ok
		? await statsRes.json()
		: { likes: {}, comments: {}, saves: {}, views: {} };
	const deniedKeys = new Set(
		deniedList.map((d: any) => d.key ?? (d.uuid ? `${d.uuid}/${d.slug}` : d.slug))
	);

	const countFor = (e: any, metric: string): number => {
		// SocialHarness keys engagement by the slug's last path segment.
		const s = e.slug ?? e.pathKey;
		const v = stats[metric]?.[s];
		return typeof v === 'number' ? v : Number(v ?? 0) || 0;
	};

	const rows = entries.map((e: any) => {
		const key = deniedKeyFor(type, e);
		return {
			...e,
			pathKey: key,
			denied: deniedKeys.has(key),
			url: e.url ?? `/${type}/${e.slug}`,
			views: countFor(e, 'views'),
			likes: countFor(e, 'likes'),
			comments: countFor(e, 'comments')
		};
	});

	return {
		type,
		base: GEO_ASTRO_BASE,
		rows,
		count: rows.length,
		denied: deniedList,
		deniedCount: deniedList.length
	};
}

export function buildContentActions(kind: string) {
	return {
		delete: async (event: any) => {
			const { request, platform } = event;
			const adminKey = platform?.env?.ADMIN_SECRET;
			const authHeaders: Record<string, string> = { 'content-type': 'application/json' };
			if (adminKey) authHeaders['x-admin-key'] = adminKey;
			const form = await request.formData();
			const slug = String(form.get('slug') ?? '');
			const uuid = form.get('uuid') ? String(form.get('uuid')) : undefined;
			if (!slug) return { error: 'slug required' };
			const res = await geoAstroFetch(platform, `${ADMIN_API}/${kind}`, {
				method: 'POST',
				headers: authHeaders,
				body: JSON.stringify({ action: 'delete', slug, uuid })
			});
			if (!res.ok) return { error: `geo-astro-site responded ${res.status}` };
			return { success: true };
		},
		restore: async (event: any) => {
			const { request, platform } = event;
			const adminKey = platform?.env?.ADMIN_SECRET;
			const authHeaders: Record<string, string> = { 'content-type': 'application/json' };
			if (adminKey) authHeaders['x-admin-key'] = adminKey;
			const form = await request.formData();
			const slug = String(form.get('slug') ?? '');
			const uuid = form.get('uuid') ? String(form.get('uuid')) : undefined;
			if (!slug) return { error: 'slug required' };
			const res = await geoAstroFetch(platform, `${ADMIN_API}/${kind}`, {
				method: 'POST',
				headers: authHeaders,
				body: JSON.stringify({ action: 'restore', slug, uuid })
			});
			if (!res.ok) return { error: `geo-astro-site responded ${res.status}` };
			return { success: true };
		}
	};
}
