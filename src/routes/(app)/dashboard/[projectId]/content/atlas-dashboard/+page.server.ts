import { serverError } from '$lib/server/agents';
import { geoAstroFetch } from '$lib/server/geo-astro';
import { getAtlasStatus, type AtlasStatus } from '$lib/server/update-worker';
import type { PageServerLoad } from './$types';

const GEO_ASTRO_PROD_BASE = 'https://geo-astro-site.foodstarmelbourne.workers.dev';
const GEO_ASTRO_PREVIEW_BASE = 'https://preview-geo-astro-site.foodstarmelbourne.workers.dev';
const UPDATE_WORKER_PROD_BASE = 'https://update.foodstarmelbourne.workers.dev';

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

type EnvKey = 'production' | 'preview';

interface AtlasEntry {
	slug?: string;
	name?: string;
	iata?: string;
	continent?: string;
	pop?: number;
	categoryUuid?: string;
	attachedAddresses?: number;
	attachedStreets?: number;
	streetsCovered?: number;
	doorPoints?: number;
}

interface EnvCoverage {
	ok: boolean;
	error: string | null;
	env: EnvKey;
	base: string;
	live: Record<string, { route: string }>;
	/** prefix → family key → manifest slug (null = not in this env's manifest) */
	slugsByPrefix: Record<string, Record<string, string | null>>;
	cities: {
		name: string;
		iata: string;
		continent: string;
		pop: number;
		prefix: string;
		attachedAddresses: number;
		attachedStreets: number;
	}[];
	pageOnly: { slug: string; route: string }[];
	pageOnlyCount: number;
	count: number;
	lastUpdated: {
		collections: string | null;
	};
}

async function loadCollectionsAndIndex(
	platform: unknown,
	env: EnvKey
): Promise<{ collRes: Response; indexRes: Response }> {
	if (env === 'preview') {
		const [collRes, indexRes] = await Promise.all([
			fetch(`${GEO_ASTRO_PREVIEW_BASE}/data/atlas-collections.json`, {
				headers: { accept: 'application/json' },
				signal: AbortSignal.timeout(15000)
			}),
			fetch(`${GEO_ASTRO_PREVIEW_BASE}/api/map-index.json`, {
				headers: { accept: 'application/json' },
				signal: AbortSignal.timeout(15000)
			})
		]);
		return { collRes, indexRes };
	}

	const [collRes, indexRes] = await Promise.all([
		// Live manifest: build-time seed (public/data/atlas-collections.json,
		// regenerated every geo-site build) with an R2 override first when the
		// Collections dashboard has edited it (src/worker.ts serves the override).
		geoAstroFetch(platform as Parameters<typeof geoAstroFetch>[0], '/data/atlas-collections.json'),
		// Live page list: build-time radar of src/pages/maps + src/pages/atlas
		// complemented by R2-generated /maps/<uuid>/ maps.
		geoAstroFetch(platform as Parameters<typeof geoAstroFetch>[0], '/api/map-index.json')
	]);
	return { collRes, indexRes };
}

function buildEnvCoverage(
	env: EnvKey,
	collRes: Response,
	indexRes: Response,
	collections: Record<string, AtlasEntry[]>,
	rawMaps: AtlasEntry[]
): EnvCoverage {
	const base = env === 'preview' ? GEO_ASTRO_PREVIEW_BASE : GEO_ASTRO_PROD_BASE;
	const collLastModified =
		collRes.headers.get('last-modified') || collRes.headers.get('date') || null;

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

	// Dynamic Atlases: all entries across all 6 families in collections are served live via SSR catch-all /atlas/[...slug].astro
	for (const t of TYPE_DEFS) {
		const entries = collections[t.key] ?? [];
		for (const e of entries) {
			const slug = String(e.slug ?? '');
			if (slug && !live.has(slug)) {
				live.set(slug, { route: '/atlas/' });
			}
		}
	}

	const cityEntries = collections.City ?? [];
	const cities = cityEntries.map((c) => {
		const name = String(c.slug ?? '').replace(/-city-atlas$/i, '');
		const prefix = name;
		return {
			name: String(c.name ?? prefix),
			iata: String(c.iata ?? ''),
			continent: String(c.continent ?? ''),
			pop: Number(c.pop) || 0,
			prefix,
			attachedAddresses: Number(c.attachedAddresses ?? c.doorPoints ?? 0),
			attachedStreets: Number(c.attachedStreets ?? c.streetsCovered ?? 0)
		};
	});

	const slugsByPrefix: Record<string, Record<string, string | null>> = {};
	for (const c of cities) {
		const slugs: Record<string, string | null> = {};
		for (const t of TYPE_DEFS) {
			const arr = collections[t.key] ?? [];
			const entry = arr.find((e) => e.slug === `${c.prefix}-${t.suffix}`);
			slugs[t.key] = entry ? (entry.slug ?? null) : null;
		}
		slugsByPrefix[c.prefix] = slugs;
	}

	// Pages on disk but not in manifest ("page-only").
	const referenced = new Set<string>();
	for (const c of cities)
		for (const t of TYPE_DEFS) {
			const slug = slugsByPrefix[c.prefix]?.[t.key];
			if (slug) referenced.add(slug);
		}
	const pageOnly = [...live.keys()]
		.filter((slug) => !referenced.has(slug))
		.sort()
		.map((slug) => ({ slug, route: live.get(slug)!.route }));

	return {
		ok: collRes.ok && indexRes.ok,
		error: !collRes.ok
			? `/data/atlas-collections.json responded ${collRes.status}`
			: !indexRes.ok
				? `/api/map-index.json responded ${indexRes.status}`
				: null,
		env,
		base,
		live: Object.fromEntries(live),
		slugsByPrefix,
		cities,
		pageOnly,
		pageOnlyCount: pageOnly.length,
		count: cities.length,
		lastUpdated: { collections: collLastModified }
	};
}

async function loadEnvCoverage(platform: unknown, env: EnvKey): Promise<EnvCoverage> {
	try {
		const { collRes, indexRes } = await loadCollectionsAndIndex(platform, env);
		if (!collRes.ok || !indexRes.ok) {
			return buildEnvCoverage(
				env,
				collRes,
				indexRes,
				{},
				[]
			);
		}
		const collections = (await collRes.json()) as Record<string, AtlasEntry[]>;
		const indexJson: unknown = await indexRes.json();
		const rawMaps: AtlasEntry[] = (
			Array.isArray(indexJson) ? indexJson : ((indexJson as { maps?: AtlasEntry[] }).maps ?? [])
		) as AtlasEntry[];
		return buildEnvCoverage(env, collRes, indexRes, collections, rawMaps);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			ok: false,
			error: msg,
			env,
			base: env === 'preview' ? GEO_ASTRO_PREVIEW_BASE : GEO_ASTRO_PROD_BASE,
			live: {},
			slugsByPrefix: {},
			cities: [],
			pageOnly: [],
			pageOnlyCount: 0,
			count: 0,
			lastUpdated: { collections: null }
		};
	}
}

export const load: PageServerLoad = async ({ platform }) => {
	// Always load BOTH master (production) and preview so the dashboard can
	// show branch coverage side by side — no ?env= toggle required.
	const [production, preview, atlasStatus] = await Promise.all([
		loadEnvCoverage(platform, 'production'),
		loadEnvCoverage(platform, 'preview'),
		// POI status lives on the update-worker (production); best-effort.
		(async () => {
			try {
				const direct = await fetch(`${UPDATE_WORKER_PROD_BASE}/atlas/status`, {
					headers: { accept: 'application/json' },
					signal: AbortSignal.timeout(10000)
				});
				if (direct.ok) {
					return (await direct.json().catch(() => null)) as AtlasStatus | null;
				}
			} catch {
				/* fall through */
			}
			try {
				return await getAtlasStatus(platform as Parameters<typeof getAtlasStatus>[0]);
			} catch {
				return null;
			}
		})()
	]);

	if (!production.ok && !preview.ok) {
		serverError(
			502,
			`Both geo-astro-site workers failed — production: ${production.error ?? 'unknown'}; preview: ${preview.error ?? 'unknown'}`
		);
	}

	// Union of city rows across both branches (keyed by prefix). Prefer
	// production metadata, fall back to preview for preview-only cities.
	const byPrefix = new Map<
		string,
		{
			name: string;
			iata: string;
			continent: string;
			pop: number;
			prefix: string;
			attachedAddresses: number;
			attachedStreets: number;
			prodSlugs: Record<string, string | null> | null;
			prevSlugs: Record<string, string | null> | null;
		}
	>();

	for (const [src, key] of [
		[preview, 'prevSlugs'],
		[production, 'prodSlugs']
	] as const) {
		for (const c of src.cities) {
			const slugs = src.slugsByPrefix[c.prefix] ?? {};
			const existing = byPrefix.get(c.prefix);
			if (existing) {
				if (key === 'prodSlugs') existing.prodSlugs = slugs;
				else existing.prevSlugs = slugs;
			} else {
				byPrefix.set(c.prefix, {
					name: c.name,
					iata: c.iata,
					continent: c.continent,
					pop: c.pop,
					prefix: c.prefix,
					attachedAddresses: c.attachedAddresses,
					attachedStreets: c.attachedStreets,
					prodSlugs: key === 'prodSlugs' ? slugs : null,
					prevSlugs: key === 'prevSlugs' ? slugs : null
				});
			}
		}
	}

	const cities = [...byPrefix.values()].sort((a, b) => a.name.localeCompare(b.name));

	return {
		types: TYPE_DEFS,
		cities,
		production,
		preview,
		count: cities.length,
		base: production.ok ? production.base : preview.base,
		env: production.ok ? 'production' : 'preview',
		loadedAt: new Date().toISOString(),
		lastUpdated: {
			collections: production.lastUpdated.collections ?? preview.lastUpdated.collections,
			prodCollections: production.lastUpdated.collections,
			prevCollections: preview.lastUpdated.collections,
			poiLastRun: atlasStatus?.status?.lastRunAt ?? null,
			poiDry: atlasStatus?.status?.dry ?? null,
			registryGeneratedAt: atlasStatus?.registry?.generatedAt ?? null,
			inProgress: !!atlasStatus?.progress && atlasStatus.progress.phase !== 'done',
			progressBatchAt: atlasStatus?.progress?.lastBatchAt ?? null,
			progressCitiesDone: atlasStatus?.progress?.citiesDone ?? null,
			progressTotalCities: atlasStatus?.progress?.cities?.length ?? 500
		}
	};
};
