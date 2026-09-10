import { serverError } from '$lib/server/agents';
import { geoAstroFetch } from '$lib/server/geo-astro';
import type { PageServerLoad } from './$types';

const GEO_ASTRO_PROD_BASE = 'https://geo-astro-site.foodstarmelbourne.workers.dev';
const GEO_ASTRO_PREVIEW_BASE = 'https://preview-geo-astro-site.foodstarmelbourne.workers.dev';

export interface CatalogDataset {
	id: string;
	name: string;
	category: string;
	source: string;
	sourceUrl: string;
	license: string;
	format: string;
	storageBucket: 'geo-datalake' | 'globe';
	storagePrefix: string;
	filesSummary: string;
	approxSize: string;
	recordCount: string;
	updateCadence: string;
	description: string;
	querySnippet?: string;
	referencedRoutes: {
		category: 'maps' | 'atlas' | 'portal' | 'guide';
		count: number;
		sampleUrls: { label: string; href: string }[];
	}[];
}

export interface CatalogResponse {
	ok: boolean;
	summary: {
		totalDatasets: number;
		datalakeDatasets: number;
		globeLayerDatasets: number;
		activeRoutes: {
			maps: number;
			atlas: number;
			portal: number;
			guide: number;
		};
		generatedAt: string;
	};
	datasets: CatalogDataset[];
}

export const load: PageServerLoad = async ({ platform, url }) => {
	const reqEnv = url.searchParams.get('env');
	const isPreviewExplicit = reqEnv === 'preview';
	const isProductionExplicit = reqEnv === 'production';

	let catalogRes: Response | null = null;
	let activeEnv: 'preview' | 'production' = isPreviewExplicit ? 'preview' : 'production';
	let activeBase = activeEnv === 'preview' ? GEO_ASTRO_PREVIEW_BASE : GEO_ASTRO_PROD_BASE;

	// 1. If explicit preview requested, fetch directly from preview
	if (isPreviewExplicit) {
		try {
			catalogRes = await fetch(`${GEO_ASTRO_PREVIEW_BASE}/api/data-catalog.json`, {
				headers: { accept: 'application/json' },
				signal: AbortSignal.timeout(15000)
			});
		} catch (e) {}
	} else if (isProductionExplicit) {
		// Explicit production requested
		try {
			catalogRes = await geoAstroFetch(platform, '/api/data-catalog.json');
		} catch (e) {
			try {
				catalogRes = await fetch(`${GEO_ASTRO_PROD_BASE}/api/data-catalog.json`, {
					headers: { accept: 'application/json' },
					signal: AbortSignal.timeout(15000)
				});
			} catch (err) {}
		}
	} else {
		// Default auto mode: try GEO_ASTRO binding (production) first
		try {
			catalogRes = await geoAstroFetch(platform, '/api/data-catalog.json');
		} catch (e) {}

		// If production 404s (e.g. preview branch hasn't merged to master yet), auto-fallback to preview worker
		if (!catalogRes || !catalogRes.ok) {
			try {
				const previewRes = await fetch(`${GEO_ASTRO_PREVIEW_BASE}/api/data-catalog.json`, {
					headers: { accept: 'application/json' },
					signal: AbortSignal.timeout(15000)
				});
				if (previewRes.ok) {
					catalogRes = previewRes;
					activeEnv = 'preview';
					activeBase = GEO_ASTRO_PREVIEW_BASE;
				}
			} catch (e) {}
		}
	}

	if (!catalogRes || !catalogRes.ok) {
		return {
			ok: false,
			error: `Data catalog responded with status ${catalogRes ? catalogRes.status : '404'}. The /api/data-catalog.json endpoint is live on the Preview Worker (toggle "Preview (CI)" above), and will be live on production once the preview branch is merged to master.`,
			base: activeBase,
			env: activeEnv,
			summary: null,
			datasets: []
		};
	}

	const data = (await catalogRes.json()) as CatalogResponse;

	return {
		ok: true,
		base: activeBase,
		env: activeEnv,
		summary: data.summary,
		datasets: data.datasets || []
	};
};