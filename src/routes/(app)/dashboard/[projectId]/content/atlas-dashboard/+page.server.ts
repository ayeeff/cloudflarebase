import { serverError } from '$lib/server/agents';
import { geoAstroFetch } from '$lib/server/geo-astro';
import type { PageServerLoad } from './$types';

const GEO_ASTRO_BASE = 'https://geo-astro-site.foodstarmelbourne.workers.dev';

// Mirrors the atlas/manifest.json TYPE_DEFS used by the repo-local
// atlas/generate-dashboard.cjs. Each per-city atlas family derives its slug as
// <prefix>-<suffix>, so a live page with an -atlas / -expensive-suburbs name
// can be matched back to its manifest slot.
const TYPE_DEFS = [
	{ key: 'City', label: 'City', suffix: 'city-atlas' },
	{ key: 'Schools', label: 'Schools', suffix: 'schools-atlas' },
	{ key: 'Universities', label: 'Universities', suffix: 'universities-atlas' },
	{ key: 'Religious', label: 'Worship', suffix: 'worship-atlas' },
	{ key: 'Property/Suburbs', label: 'Expensive Suburbs', suffix: 'expensive-suburbs' },
	{ key: 'Metro', label: 'Metro / Train', suffix: 'metro-train-atlas' }
];

const FAMILY_RE = /-atlas$|-expensive-suburbs$/i;

export const load: PageServerLoad = async ({ platform }) => {
	const [collRes, indexRes] = await Promise.all([
		// Live manifest: build-time seed (public/data/atlas-collections.json,
		// regenerated every geo-site build) with an R2 override first when the
		// Collections dashboard has edited it (src/worker.ts serves the override).
		geoAstroFetch(platform, '/data/atlas-collections.json'),
		// Live page list: build-time radar of src/pages/maps + src/pages/atlas
		// complemented by R2-generated /maps/<uuid>/ maps.
		geoAstroFetch(platform, '/api/map-index.json')
	]);

	if (!collRes.ok) {
		serverError(502, `geo-astro-site /data/atlas-collections.json responded ${collRes.status}`);
	}
	if (!indexRes.ok) {
		serverError(502, `geo-astro-site /api/map-index.json responded ${indexRes.status}`);
	}

	interface AtlasEntry {
		slug?: string;
		name?: string;
		iata?: string;
		continent?: string;
		pop?: number;
		categoryUuid?: string;
	}

	const collections = (await collRes.json()) as Record<string, AtlasEntry[]>;
	const indexJson: unknown = await indexRes.json();
	const rawMaps: AtlasEntry[] = (
		Array.isArray(indexJson) ? indexJson : ((indexJson as { maps?: AtlasEntry[] }).maps ?? [])
	) as AtlasEntry[];

	// Live page lookup restricted to per-city family names — that covers every
	// matrix cell (expected slugs all end in -atlas / -expensive-suburbs) plus
	// the page-only detection, while ignoring unrelated maps. A generated
	// /chat map reusing a family slug carries categoryUuid and lives under
	// /maps/<uuid>/; everything else is a build-time /atlas/ page.
	const live = new Map<string, { route: string }>();
	for (const m of rawMaps) {
		const slug = String(m.slug ?? '');
		if (!slug || !FAMILY_RE.test(slug)) continue;
		if (m.categoryUuid) live.set(slug, { route: `/maps/${m.categoryUuid}/` });
		else live.set(slug, { route: '/atlas/' });
	}

	const cityEntries = collections.City ?? [];
	const cities = cityEntries.map((c) => {
		const name = String(c.slug ?? '').replace(/-city-atlas$/i, '');
		const prefix = name;
		const slugs: Record<string, string | null> = {};
		for (const t of TYPE_DEFS) {
			const arr = collections[t.key] ?? [];
			const entry = arr.find((e) => e.slug === `${prefix}-${t.suffix}`);
			slugs[t.key] = entry ? (entry.slug ?? null) : null;
		}
		return {
			name: String(c.name ?? prefix),
			iata: String(c.iata ?? ''),
			continent: String(c.continent ?? ''),
			pop: Number(c.pop) || 0,
			prefix,
			slugs
		};
	});

	// Pages on disk but not in manifest ("page-only").
	const referenced = new Set<string>();
	for (const c of cities)
		for (const t of TYPE_DEFS) {
			const slug = c.slugs[t.key];
			if (slug) referenced.add(slug);
		}
	const pageOnly = [...live.keys()]
		.filter((slug) => !referenced.has(slug))
		.sort()
		.map((slug) => ({ slug, route: live.get(slug)!.route }));

	return {
		types: TYPE_DEFS,
		cities,
		live: Object.fromEntries(live),
		pageOnly,
		pageOnlyCount: pageOnly.length,
		count: cities.length,
		base: GEO_ASTRO_BASE,
		loadedAt: new Date().toISOString()
	};
};
