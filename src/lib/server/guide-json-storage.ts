// src/lib/server/guide-json-storage.ts
//
// Storage report and presence tracking for City Guide dataset files
// across Cloudflare R2 (globe/data/guide/<slug>/).

import fallbackReport from '$lib/data/guide-json-report.json';

export const GUIDE_STANDARD_FILES = ['pack.json', 'data.json', 'pois.json', 'landmarks.json'] as const;
export type GuideStandardFile = (typeof GUIDE_STANDARD_FILES)[number];

export interface GuideFileCategoryDef {
	id: string;
	name: string;
	description: string;
	files: GuideStandardFile[];
}

export const GUIDE_FILE_CATEGORIES: GuideFileCategoryDef[] = [
	{
		id: 'bundles',
		name: 'Packs & Metadata',
		description: 'Consolidated city payload (pack.json) and legacy data definitions (data.json)',
		files: ['pack.json', 'data.json']
	},
	{
		id: 'features',
		name: 'Spatial POIs & Landmarks',
		description: 'Complete OSM amenity points (pois.json) and curated gold landmark features (landmarks.json)',
		files: ['pois.json', 'landmarks.json']
	}
];

export interface GuideCityStorage {
	slug: string;
	name: string;
	country: string;
	continent: string;
	pop: number;
	poisCount: number;
	landmarksCount: number;
	files: Record<GuideStandardFile, boolean>;
	missing: GuideStandardFile[];
	isComplete: boolean;
	r2Path: string;
	previewUrl: string;
}

export interface GuideStorageReport {
	source: 'live-r2' | 'registry-cache' | 'derived-inventory';
	generatedAt: string;
	filesChecked: readonly GuideStandardFile[];
	totals: {
		totalGuides: number;
		guidesComplete: number;
		guidesWithMissing: number;
		totalPois: number;
		totalLandmarks: number;
		files: Record<GuideStandardFile, { present: number; missing: number }>;
	};
	byGuide: Record<string, GuideCityStorage>;
}

const CANDIDATE_GUIDE_KEYS = [
	'registry/guide-json-registry.json',
	'registry/guide-json-report.json'
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

export async function loadGuideStorageReport(platform: any): Promise<GuideStorageReport> {
	const env = platform?.env;
	const globe: R2Bucket | undefined = env?.GLOBE;

	// 1. Try reading R2 cached registry
	if (globe) {
		try {
			for (const key of CANDIDATE_GUIDE_KEYS) {
				const cached = await globe.get(key);
				if (cached) {
					const json = (await cached.json()) as any;
					if (json && json.totals && json.byGuide) {
						return {
							source: 'registry-cache',
							generatedAt: json.generatedAt || new Date().toISOString(),
							filesChecked: GUIDE_STANDARD_FILES,
							totals: json.totals,
							byGuide: json.byGuide
						};
					}
				}
			}
		} catch {
			/* fallback to live scan or static report */
		}
	}

	// 2. Try live scan if bucket bound
	if (globe) {
		try {
			const keys = await listAllKeys(globe, 'data/guide/');
			const base = fallbackReport as GuideStorageReport;
			const byGuide: Record<string, GuideCityStorage> = {};

			let complete = 0;
			let withMissing = 0;
			const fileTotals = Object.fromEntries(
				GUIDE_STANDARD_FILES.map((f) => [f, { present: 0, missing: 0 }])
			) as Record<GuideStandardFile, { present: number; missing: number }>;

			for (const [slug, entry] of Object.entries(base.byGuide)) {
				const files = {} as Record<GuideStandardFile, boolean>;
				const missing: GuideStandardFile[] = [];

				for (const f of GUIDE_STANDARD_FILES) {
					const hasFile = keys.has(`data/guide/${slug}/${f}`);
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

				byGuide[slug] = {
					...entry,
					files,
					missing,
					isComplete
				};
			}

			return {
				source: 'live-r2',
				generatedAt: new Date().toISOString(),
				filesChecked: GUIDE_STANDARD_FILES,
				totals: {
					totalGuides: Object.keys(byGuide).length,
					guidesComplete: complete,
					guidesWithMissing: withMissing,
					totalPois: base.totals.totalPois,
					totalLandmarks: base.totals.totalLandmarks,
					files: fileTotals
				},
				byGuide
			};
		} catch {
			/* fallback to static report */
		}
	}

	// 3. Fallback to static seed report
	return fallbackReport as GuideStorageReport;
}

export async function saveGuideRegistryToR2(platform: any, report: GuideStorageReport): Promise<boolean> {
	const env = platform?.env;
	const globe: R2Bucket | undefined = env?.GLOBE;
	if (!globe) return false;

	try {
		const payload = JSON.stringify(report, null, 2);
		await Promise.all(
			CANDIDATE_GUIDE_KEYS.map((key) =>
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
