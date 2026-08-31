import { geoAstroFetch } from '$lib/server/geo-astro';
import { serverError } from '$lib/server/agents';
import { parseSitemapXml } from './sitemap-xml';
import type { PageServerLoad } from './$types';

const GEO_ASTRO_BASE = 'https://geo-astro-site.foodstarmelbourne.workers.dev';

export const load: PageServerLoad = async ({ platform }) => {
	let res: Response;
	try {
		res = await geoAstroFetch(platform, '/sitemap.xml');
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return serverError(502, `GEO_ASTRO binding unavailable: ${message}`);
	}

	if (res.status === 404) {
		// sitemap.xml is a build artifact of geo-astro-site's preview branch;
		// until that merges to master the production Worker has no such asset.
		return { missing: true, base: GEO_ASTRO_BASE, fetchedAt: null };
	}
	if (!res.ok) {
		return serverError(502, `geo-astro-site /sitemap.xml responded ${res.status}`);
	}

	const xml = await res.text();
	const entries = parseSitemapXml(xml);

	const sectionCounts = new Map<string, number>();
	for (const e of entries) {
		const seg = e.path === '/' ? '(root)' : e.path.split('/')[1];
		sectionCounts.set(seg, (sectionCounts.get(seg) ?? 0) + 1);
	}
	const sections = [...sectionCounts.entries()]
		.map(([name, count]) => ({ name, count }))
		.sort((a, b) => b.count - a.count);

	return {
		missing: false,
		base: GEO_ASTRO_BASE,
		entries,
		count: entries.length,
		sections,
		fetchedAt: new Date().toISOString()
	};
};
