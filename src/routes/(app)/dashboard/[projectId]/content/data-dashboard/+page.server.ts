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
	const isPreview = url.searchParams.get('env') === 'preview';
	const base = isPreview ? GEO_ASTRO_PREVIEW_BASE : GEO_ASTRO_PROD_BASE;

	let catalogRes: Response | null = null;
	try {
		if (isPreview) {
			catalogRes = await fetch(`${GEO_ASTRO_PREVIEW_BASE}/api/data-catalog.json`, {
				headers: { accept: 'application/json' },
				signal: AbortSignal.timeout(15000)
			});
		} else {
			catalogRes = await geoAstroFetch(platform, '/api/data-catalog.json');
		}
	} catch (err) {
		try {
			catalogRes = await fetch(`${base}/api/data-catalog.json`, {
				headers: { accept: 'application/json' },
				signal: AbortSignal.timeout(15000)
			});
		} catch (e) {
			return {
				ok: false,
				error: `Data catalog unreachable: ${e instanceof Error ? e.message : String(e)}`,
				base,
				summary: null,
				datasets: []
			};
		}
	}

	if (!catalogRes || !catalogRes.ok) {
		return {
			ok: false,
			error: `Data catalog responded with status ${catalogRes ? catalogRes.status : '500'}`,
			base,
			summary: null,
			datasets: []
		};
	}

	const data = (await catalogRes.json()) as CatalogResponse;

	return {
		ok: true,
		base,
		summary: data.summary,
		datasets: data.datasets || []
	};
};