// site/cloudflarebase/src/lib/server/layer-json-storage.ts
//
// Tracking presence of 9 extracted layer JSON datasets across R2 (globe/data/<slug>-2d/):
// 1. terrain.json     (Mountain relief, elevation contours, and peaks above 200m)
// 2. bathymetry.json  (Bathymetry DEM depth points & underwater relief)
// 3. kartaview.json   (Street View camera coverage polygon footprint)
// 4. mapillary.json   (Street-level sequence traces and optical nodes)
// 5. osmtransit.json  (OSM transit relation lines and routes)
// 6. population.json  (Kontur 400m H3 population hexagon density)
// 7. power.json       (Grid power lines & distribution substations)
// 8. speed.json       (Ookla fixed & mobile internet speed performance)
// 9. transit.json     (GTFS scheduled transit routes and station stops)

import seedCities from '$lib/data/atlas-themes-seed.json';
import cityQid from '$lib/data/city-qid.json';

export const LAYER_JSON_FILES = [
	{
		id: 'terrain',
		name: 'Terrain Relief',
		file: 'terrain.json',
		accent: '#64748b',
		description: 'Mountain relief, elevation contours, and peaks above 200m'
	},
	{
		id: 'bathymetry',
		name: 'Bathymetry Relief',
		file: 'bathymetry.json',
		accent: '#0284c7',
		description: 'Ocean depth points, elevation contours, and underwater relief'
	},
	{
		id: 'population',
		name: 'Kontur Population',
		file: 'population.json',
		accent: '#4fd1a5',
		description: 'Kontur 400m H3 population hexagon density'
	},
	{
		id: 'speed',
		name: 'Ookla Speed',
		file: 'speed.json',
		accent: '#f59e0b',
		description: 'Fixed & mobile internet speed performance lines'
	},
	{
		id: 'transit',
		name: 'GTFS Transit',
		file: 'transit.json',
		accent: '#38bdf8',
		description: 'Standardized scheduled transit routes and station stops'
	},
	{
		id: 'osmtransit',
		name: 'OSM Transit',
		file: 'osmtransit.json',
		accent: '#8b5cf6',
		description: 'OSM railway, subway, tram, and bus relation ways'
	},
	{
		id: 'power',
		name: 'Power Grid',
		file: 'power.json',
		accent: '#ec4899',
		description: 'High-voltage grid lines, cables, and distribution substations'
	},
	{
		id: 'kartaview',
		name: 'Street View Karta',
		file: 'kartaview.json',
		accent: '#06b6d4',
		description: 'Street-level camera coverage polygon footprint'
	},
	{
		id: 'mapillary',
		name: 'Mapillary Sequences',
		file: 'mapillary.json',
		accent: '#10b981',
		description: 'Street view sequence traces and optical nodes'
	}
] as const;

export type LayerJsonId = (typeof LAYER_JSON_FILES)[number]['id'];

export interface CityLayerRecord {
	slug: string;
	name: string;
	country: string;
	continent: string;
	pop: number;
	layers: Record<LayerJsonId, { present: boolean; size?: number }>;
	presentCount: number;
	missingCount: number;
	isComplete: boolean;
}

export interface LayerJsonReport {
	source: 'registry-cache' | 'live-r2' | 'seed';
	generatedAt: string;
	totalCities: number;
	summary: Record<LayerJsonId, { present: number; missing: number }>;
	cities: CityLayerRecord[];
}

const LAYER_REGISTRY_KEY = 'registry/layer-json-registry.json';

export async function loadLayerJsonReport(platform: any): Promise<LayerJsonReport> {
	const env = platform?.env;
	const globe = env?.GLOBE;

	if (globe) {
		try {
			const cached = await globe.get(LAYER_REGISTRY_KEY);
			if (cached) {
				const json = (await cached.json()) as any;
				if (json && json.cities && json.summary) {
					return json;
				}
			}
		} catch {}
	}

	try {
		const seedReport = await import('$lib/data/layer-json-report.json');
		if (seedReport.default && seedReport.default.cities && seedReport.default.summary) {
			return seedReport.default as any;
		}
	} catch {}

	// Fallback: build from seed cities and cityQid
	const rawCities = (seedCities as any).cities || [];
	const summary = {} as Record<LayerJsonId, { present: number; missing: number }>;
	for (const l of LAYER_JSON_FILES) {
		summary[l.id] = { present: 0, missing: 0 };
	}

	const cities: CityLayerRecord[] = [];

	for (const c of rawCities) {
		const slug = String(c.slug || '').replace(/-city-atlas$/, '').toLowerCase();
		if (!slug || slug === 'newyorkcity') continue;

		const qidInfo = (cityQid as Record<string, any>)[slug] || (cityQid as Record<string, any>)[slug.replace(/-/g, '')];

		// By default check known layers or initialize
		const layerPresence: Record<LayerJsonId, { present: boolean }> = {
			terrain: false,
			bathymetry: false,
			population: false,
			speed: false,
			transit: false,
			osmtransit: false,
			power: false,
			kartaview: false,
			mapillary: false
		};

		let presentCount = 0;
		for (const l of LAYER_JSON_FILES) {
			if (layerPresence[l.id].present) {
				presentCount++;
				summary[l.id].present++;
			} else {
				summary[l.id].missing++;
			}
		}

		cities.push({
			slug,
			name: c.name || qidInfo?.municipality || slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' '),
			country: c.country || qidInfo?.country || 'Global',
			continent: c.continent || qidInfo?.continent || 'Global',
			pop: Number(c.pop || qidInfo?.pop || 0),
			layers: layerPresence,
			presentCount,
			missingCount: LAYER_JSON_FILES.length - presentCount,
			isComplete: presentCount === LAYER_JSON_FILES.length
		});
	}

	cities.sort((a, b) => b.pop - a.pop || a.name.localeCompare(b.name));

	return {
		source: 'seed',
		generatedAt: new Date().toISOString(),
		totalCities: cities.length,
		summary,
		cities
	};
}

export async function saveLayerJsonRegistryToR2(platform: any, report: LayerJsonReport): Promise<boolean> {
	const env = platform?.env;
	const globe = env?.GLOBE;
	if (!globe) return false;

	try {
		await globe.put(LAYER_REGISTRY_KEY, JSON.stringify(report, null, 2), {
			httpMetadata: { contentType: 'application/json' }
		});
		return true;
	} catch {
		return false;
	}
}
