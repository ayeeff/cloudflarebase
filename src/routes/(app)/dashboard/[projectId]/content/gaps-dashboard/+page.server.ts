import type { PageServerLoad } from './$types';
import * as Sentry from '@sentry/sveltekit';

// Layer-gaps dashboard: dual branch coverage. The live layers-worker GET /gaps
// supplies the candidate registry, then each git branch's committed
// basemaps/manifest.json is scored separately so the matrix shows what the
// preview CI build knows vs what production master knows. The repo is private,
// so raw.githubusercontent 404s — fetch each branch's build-time manifest from
// the corresponding geo Worker deploy (same dual-env pattern as atlas-dashboard).
// Same access pattern as the pmtiles/streetview dashboards: LAYERS service
// binding first (two Workers on the same account cannot fetch() each other by
// URL — Cloudflare error 1042), public URL fallback for local dev.
const LAYERS_GAPS = 'https://layers-worker.foodstarmelbourne.workers.dev/gaps';
const LAYERS_BINDING_URL = 'https://layers-worker/gaps';
const GEO_ASTRO_PROD_BASE = 'https://geo-astro-site.foodstarmelbourne.workers.dev';
const GEO_ASTRO_PREVIEW_BASE = 'https://preview-geo-astro-site.foodstarmelbourne.workers.dev';
const MANIFEST_URL: Record<string, string> = {
	preview: `${GEO_ASTRO_PREVIEW_BASE}/api/basemaps-manifest.json`,
	master: `${GEO_ASTRO_PROD_BASE}/api/basemaps-manifest.json`
};

interface Gaps {
	ok: boolean;
	generatedAt: string;
	manifestGeneratedAt: string | null;
	manifestFiles: number;
	totals: { candidates: number; withBase: number; noBase: number };
	perLayer: Record<string, number>;
	union: { noBase: string[]; layers: Record<string, string[]> };
	candidates: { slug: string; display: string; hasBase: boolean; missing: string[] }[];
}

interface BranchGaps {
	branch: string;
	ok: boolean;
	error: string | null;
	manifestFiles: number;
	manifestGeneratedAt: string | null;
	totals: { candidates: number; withBase: number; noBase: number };
	perLayer: Record<string, number>;
	union: { noBase: string[]; layers: Record<string, string[]> };
	candidates: { slug: string; display: string; hasBase: boolean; missing: string[] }[];
}

// Mirror of workers/layers/src/gaps.js — layer suffixes + power slug aliases.
const LAYER_KEYS = [
	'terrain',
	'satellite',
	'population',
	'speed',
	'transit',
	'power',
	'bathymetry',
	'mapillary',
	'kartaview'
] as const;
const SLUG_ALIAS: Record<string, string> = {
	newyork: 'ny',
	losangeles: 'la',
	sanfrancisco: 'sf'
};

function emptyBranch(branch: string, error: string): BranchGaps {
	return {
		branch,
		ok: false,
		error,
		manifestFiles: 0,
		manifestGeneratedAt: null,
		totals: { candidates: 0, withBase: 0, noBase: 0 },
		perLayer: {},
		union: { noBase: [], layers: {} },
		candidates: []
	};
}

// Score one branch's manifest names against the candidate registry (same
// semantics as gaps.js computeGaps).
function computeBranch(
	branch: string,
	manifest: { pmtiles?: { name: string }[]; generatedAt?: string },
	cands: { slug: string; display: string }[]
): BranchGaps {
	const names = new Set((manifest.pmtiles ?? []).map((f) => f.name));
	const candidates = cands.map(({ slug, display }) => {
		const hasBase = names.has(slug);
		const missing: string[] = [];
		for (const key of LAYER_KEYS) {
			let present = names.has(`${slug}-${key}`);
			if (!present && key === 'power' && SLUG_ALIAS[slug]) {
				present = names.has(`${SLUG_ALIAS[slug]}-power`);
			}
			if (!present) missing.push(key);
		}
		return { slug, display, hasBase, missing };
	});
	const noBase = candidates.filter((r) => !r.hasBase).map((r) => r.slug);
	const perLayer: Record<string, number> = {};
	const unionLayers: Record<string, string[]> = {};
	for (const key of LAYER_KEYS) {
		const list = candidates.filter((r) => r.hasBase && r.missing.includes(key)).map((r) => r.slug);
		unionLayers[key] = list;
		perLayer[key] = list.length;
	}
	return {
		branch,
		ok: true,
		error: null,
		manifestFiles: names.size,
		manifestGeneratedAt: typeof manifest.generatedAt === 'string' ? manifest.generatedAt : null,
		totals: {
			candidates: candidates.length,
			withBase: candidates.length - noBase.length,
			noBase: noBase.length
		},
		perLayer,
		union: { noBase, layers: unionLayers },
		candidates
	};
}

async function fetchBranchManifest(
	branch: string,
	cands: { slug: string; display: string }[]
): Promise<BranchGaps> {
	const url = MANIFEST_URL[branch];
	if (!url) return emptyBranch(branch, 'unknown branch');
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
		if (!res.ok) return emptyBranch(branch, `manifest HTTP ${res.status} (${url})`);
		const body: unknown = await res.json();
		if (!body || typeof body !== 'object') return emptyBranch(branch, 'malformed manifest JSON');
		return computeBranch(branch, body as { pmtiles?: { name: string }[] }, cands);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		Sentry.captureException(e, { tags: { source: 'gaps-dashboard', upstream: `manifest-${branch}` } });
		return emptyBranch(branch, msg);
	}
}

export const load: PageServerLoad = async ({ platform }) => {
	let res: Response | null = null;
	const init = { headers: { accept: 'application/json' } };
	try {
		if (platform?.env?.LAYERS) {
			res = await platform.env.LAYERS.fetch(LAYERS_BINDING_URL, init);
		}
	} catch (e) {
		Sentry.captureException(e, {
			tags: { source: 'gaps-dashboard', upstream: 'layers-worker-binding' }
		});
		res = null;
	}
	if (!res) {
		try {
			res = await fetch(LAYERS_GAPS, { ...init, signal: AbortSignal.timeout(20000) });
		} catch (e) {
			Sentry.captureException(e, {
				tags: { source: 'gaps-dashboard', upstream: 'layers-worker-public' }
			});
			return {
				gaps: null as Gaps | null,
				branches: null as Record<string, BranchGaps | null> | null,
				error: `layers-worker unreachable: ${e instanceof Error ? e.message : String(e)}`
			};
		}
	}
	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		return {
			gaps: null,
			branches: null,
			error: `layers-worker /gaps responded ${res.status}: ${detail.slice(0, 200)}`
		};
	}
	const body: unknown = await res.json().catch(() => null);
	if (!body || typeof body !== 'object' || !(body as Record<string, unknown>).ok) {
		return { gaps: null, branches: null, error: 'layers-worker /gaps returned a malformed payload' };
	}
	const gaps = body as Gaps;
	const cands = gaps.candidates.map((c) => ({
		slug: c.slug,
		display: c.display || c.slug
	}));
	const [preview, master] = await Promise.all([
		fetchBranchManifest('preview', cands),
		fetchBranchManifest('master', cands)
	]);
	return { gaps, branches: { preview, master } as Record<string, BranchGaps>, error: null };
};
