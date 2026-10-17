// src/lib/server/infobox-json-storage.ts
//
// Storage report and presence tracking for City AI Infobox summaries
// across Cloudflare R2 (globe/data/<slug>-2d/Infobox.json and infobox.json).

import fallbackReport from '$lib/data/infobox-json-report.json';

export interface InfoboxCityStorage {
	slug: string;
	name: string;
	country: string;
	continent: string;
	pop: number;
	hasInfobox: boolean;
	neighborhoodsCount: number;
	neighborhoodsList: string[];
	r2Path: string;
	previewUrl: string;
}

export interface InfoboxStorageReport {
	source: 'live-r2' | 'registry-cache' | 'derived-inventory';
	generatedAt: string;
	totals: {
		totalCities: number;
		citiesWithInfobox: number;
		citiesPending: number;
		totalNeighborhoodSummaries: number;
	};
	byCity: Record<string, InfoboxCityStorage>;
}

const CANDIDATE_INFOBOX_KEYS = [
	'registry/infobox-json-registry.json',
	'registry/infobox-json-report.json'
];

export async function loadInfoboxStorageReport(platform: any): Promise<InfoboxStorageReport> {
	const env = platform?.env;
	const globe: R2Bucket | undefined = env?.GLOBE;

	// 1. Try reading R2 cached registry
	if (globe) {
		try {
			for (const key of CANDIDATE_INFOBOX_KEYS) {
				const cached = await globe.get(key);
				if (cached) {
					const json = (await cached.json()) as any;
					if (json && json.totals && json.byCity) {
						return {
							source: 'registry-cache',
							generatedAt: json.generatedAt || new Date().toISOString(),
							totals: json.totals,
							byCity: json.byCity
						};
					}
				}
			}
		} catch (err) {
			console.warn('[infobox-json-storage] R2 registry read failed, falling back:', err);
		}
	}

	// 2. Fall back to bundled seed report
	return {
		source: 'derived-inventory',
		generatedAt: (fallbackReport as any).generatedAt || new Date().toISOString(),
		totals: (fallbackReport as any).totals,
		byCity: (fallbackReport as any).byCity
	};
}

export async function saveInfoboxRegistryToR2(
	platform: any,
	report: InfoboxStorageReport
): Promise<boolean> {
	const env = platform?.env;
	const globe: R2Bucket | undefined = env?.GLOBE;
	if (!globe) return false;

	const payload = JSON.stringify(
		{
			...report,
			source: 'registry-cache',
			generatedAt: new Date().toISOString()
		},
		null,
		2
	);

	await globe.put('registry/infobox-json-report.json', payload, {
		httpMetadata: { contentType: 'application/json; charset=utf-8' }
	});

	await globe.put('registry/infobox-json-registry.json', payload, {
		httpMetadata: { contentType: 'application/json; charset=utf-8' }
	});

	return true;
}
