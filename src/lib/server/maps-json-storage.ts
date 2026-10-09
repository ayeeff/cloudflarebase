// src/lib/server/maps-json-storage.ts
//
// Storage report and presence tracking for Thematic & Temporal Maps datasets
// across Cloudflare R2 (globe/data/maps/<slug>/).

import fallbackReport from '$lib/data/maps-json-report.json';

export const MAPS_STANDARD_FILES = ['pack.json', 'data.json', 'pois.json', 'landmarks.json'] as const;
export type MapsStandardFile = (typeof MAPS_STANDARD_FILES)[number];

export interface MapsFileCategoryDef {
	id: string;
	name: string;
	description: string;
	files: MapsStandardFile[];
}

export const MAPS_FILE_CATEGORIES: MapsFileCategoryDef[] = [
	{
		id: 'bundles',
		name: 'Packs & Payload Bundles',
		description: 'Consolidated map bundle (pack.json) and raw dataset array (data.json)',
		files: ['pack.json', 'data.json']
	},
	{
		id: 'features',
		name: 'GeoJSON Feature Collections',
		description: 'Mapped features & coordinate geometry (pois.json) and high-priority landmark highlights (landmarks.json)',
		files: ['pois.json', 'landmarks.json']
	}
];

export interface MapDatasetStorage {
	slug: string;
	title: string;
	category: string;
	description: string;
	featuresCount: number;
	hasYears: boolean;
	yearsCount: number;
	years: number[] | null;
	files: Record<MapsStandardFile, boolean>;
	missing: MapsStandardFile[];
	isComplete: boolean;
	r2Path: string;
	previewUrl: string;
}

export interface MapsStorageReport {
	source: 'live-r2' | 'registry-cache' | 'derived-inventory';
	generatedAt: string;
	filesChecked: readonly MapsStandardFile[];
	totals: {
		totalMaps: number;
		mapsComplete: number;
		mapsWithMissing: number;
		temporalMapsCount: number;
		totalFeatures: number;
		files: Record<MapsStandardFile, { present: number; missing: number }>;
	};
	byMap: Record<string, MapDatasetStorage>;
}

const CANDIDATE_MAPS_KEYS = [
	'registry/maps-json-registry.json',
	'registry/maps-json-report.json'
];

async function listAllKeys(bucket: R2Bucket, prefix: string): Promise<Set<string>> {
	const keys = new Set<string>();
	let cursor: string | undefined;
	do {
		const res = await bucket.list({ prefix, limit: 1000, cursor });
		for (const obj of res.objects) keys.add(obj.key);
		cursor = res.truncated ? res.cursor : undefined;
	} while (cursor);
	return keys;
}

export async function loadMapsStorageReport(platform: any): Promise<MapsStorageReport> {
	const env = platform?.env;
	const globe: R2Bucket | undefined = env?.GLOBE;

	// 1. Try reading R2 cached registry
	if (globe) {
		try {
			for (const key of CANDIDATE_MAPS_KEYS) {
				const cached = await globe.get(key);
				if (cached) {
					const json = (await cached.json()) as any;
					if (json && json.totals && json.byMap) {
						return {
							source: 'registry-cache',
							generatedAt: json.generatedAt || new Date().toISOString(),
							filesChecked: MAPS_STANDARD_FILES,
							totals: json.totals,
							byMap: json.byMap
						};
					}
				}
			}
		} catch {
			/* fallback */
		}
	}

	// 2. Try live scan if bucket bound
	if (globe) {
		try {
			const keys = await listAllKeys(globe, 'data/maps/');
			const base = fallbackReport as MapsStorageReport;
			const byMap: Record<string, MapDatasetStorage> = {};

			let complete = 0;
			let withMissing = 0;
			const fileTotals = Object.fromEntries(
				MAPS_STANDARD_FILES.map((f) => [f, { present: 0, missing: 0 }])
			) as Record<MapsStandardFile, { present: number; missing: number }>;

			for (const [slug, entry] of Object.entries(base.byMap)) {
				const files = {} as Record<MapsStandardFile, boolean>;
				const missing: MapsStandardFile[] = [];

				for (const f of MAPS_STANDARD_FILES) {
					const hasFile = keys.has(`data/maps/${slug}/${f}`);
					files[f] = hasFile;
					if (hasFile) {
						fileTotals[f].present++;
					} else {
						fileTotals[f].missing++;
						missing.push(f);
					}
				}

				const isComplete = missing.length === 0;
				if (isComplete) complete++;
				else withMissing++;

				byMap[slug] = {
					...entry,
					files,
					missing,
					isComplete
				};
			}

			return {
				source: 'live-r2',
				generatedAt: new Date().toISOString(),
				filesChecked: MAPS_STANDARD_FILES,
				totals: {
					totalMaps: Object.keys(byMap).length,
					mapsComplete: complete,
					mapsWithMissing: withMissing,
					temporalMapsCount: base.totals.temporalMapsCount,
					totalFeatures: base.totals.totalFeatures,
					files: fileTotals
				},
				byMap
			};
		} catch {
			/* fallback to static report */
		}
	}

	// 3. Fallback to static seed report
	return fallbackReport as MapsStorageReport;
}

export async function saveMapsRegistryToR2(platform: any, report: MapsStorageReport): Promise<boolean> {
	const env = platform?.env;
	const globe: R2Bucket | undefined = env?.GLOBE;
	if (!globe) return false;

	try {
		const payload = JSON.stringify(report, null, 2);
		await Promise.all(
			CANDIDATE_MAPS_KEYS.map((key) =>
				globe.put(key, payload, {
					httpMetadata: { contentType: 'application/json' }
				})
			)
		);
		return true;
	} catch {
		return false;
	}
}
