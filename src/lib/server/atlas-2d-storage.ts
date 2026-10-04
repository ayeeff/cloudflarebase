// src/lib/server/atlas-2d-storage.ts
//
// Server-side helper to verify presence of the 5 required 2D atlas data files across:
// 1) s3://geo-datalake/sources/osm/places/<slug>/
// 2) s3://globe/data/<slug>-2d/
//
// Required files:
// - demand-streets.json
// - neighborhoods.json
// - places.json
// - street-geoms.json
// - transit-lines.json

import fallbackSeed from '$lib/data/atlas-2d-missing-files.json';

export const REQUIRED_2D_FILES = [
	'demand-streets.json',
	'neighborhoods.json',
	'places.json',
	'street-geoms.json',
	'transit-lines.json'
] as const;

export type Required2DFile = (typeof REQUIRED_2D_FILES)[number];

export interface FileStatusMap {
	'demand-streets.json': boolean;
	'neighborhoods.json': boolean;
	'places.json': boolean;
	'street-geoms.json': boolean;
	'transit-lines.json': boolean;
}

export interface CityStorage2D {
	slug: string;
	datalake: FileStatusMap;
	globe: FileStatusMap;
	missing: {
		datalake: Required2DFile[];
		globe: Required2DFile[];
	};
	datalakePresentCount: number;
	globePresentCount: number;
	hasAnyMissing: boolean;
	isComplete: boolean;
}

export interface Atlas2DStorageReport {
	source: 'live-r2' | 'registry-cache' | 'bundled-seed';
	generatedAt: string;
	filesChecked: typeof REQUIRED_2D_FILES;
	totals: {
		datalake: Record<Required2DFile, { present: number; missing: number }>;
		globe: Record<Required2DFile, { present: number; missing: number }>;
		totalCities: number;
		citiesCompleteBoth: number;
		citiesWithAnyMissing: number;
	};
	byCity: Record<string, CityStorage2D>;
	missingRegistryJson: string;
}

const REGISTRY_R2_KEY = 'registry/missing-atlas-2d-files.json';

/**
 * List all objects with a given prefix using R2's list API.
 */
async function listAllR2Keys(bucket: R2Bucket, prefix: string): Promise<string[]> {
	const keys: string[] = [];
	let cursor: string | undefined;
	do {
		const res = await bucket.list({ prefix, cursor, limit: 1000 });
		for (const obj of res.objects) {
			keys.push(obj.key);
		}
		cursor = res.truncated ? res.cursor : undefined;
	} while (cursor);
	return keys;
}

/**
 * Build a report from sets of found keys.
 */
function buildReportFromSets(
	dlKeys: Set<string>,
	glKeys: Set<string>,
	citySlugs: string[],
	source: 'live-r2' | 'registry-cache' | 'bundled-seed',
	generatedAt: string = new Date().toISOString()
): Atlas2DStorageReport {
	const datalakeTotals = Object.fromEntries(
		REQUIRED_2D_FILES.map((f) => [f, { present: 0, missing: 0 }])
	) as Record<Required2DFile, { present: number; missing: number }>;

	const globeTotals = Object.fromEntries(
		REQUIRED_2D_FILES.map((f) => [f, { present: 0, missing: 0 }])
	) as Record<Required2DFile, { present: number; missing: number }>;

	const byCity: Record<string, CityStorage2D> = {};
	const missingByCity: Record<string, { datalake: string[]; globe: string[] }> = {};
	let citiesCompleteBoth = 0;

	for (const slug of citySlugs) {
		const dlStatus: FileStatusMap = {
			'demand-streets.json': false,
			'neighborhoods.json': false,
			'places.json': false,
			'street-geoms.json': false,
			'transit-lines.json': false
		};
		const glStatus: FileStatusMap = {
			'demand-streets.json': false,
			'neighborhoods.json': false,
			'places.json': false,
			'street-geoms.json': false,
			'transit-lines.json': false
		};

		const dlMissing: Required2DFile[] = [];
		const glMissing: Required2DFile[] = [];

		let dlPresentCount = 0;
		let glPresentCount = 0;

		for (const file of REQUIRED_2D_FILES) {
			const hasDl = dlKeys.has(`sources/osm/places/${slug}/${file}`);
			const hasGl = glKeys.has(`data/${slug}-2d/${file}`);

			dlStatus[file] = hasDl;
			glStatus[file] = hasGl;

			if (hasDl) {
				dlPresentCount++;
				datalakeTotals[file].present++;
			} else {
				datalakeTotals[file].missing++;
				dlMissing.push(file);
			}

			if (hasGl) {
				glPresentCount++;
				globeTotals[file].present++;
			} else {
				globeTotals[file].missing++;
				glMissing.push(file);
			}
		}

		const hasAnyMissing = dlMissing.length > 0 || glMissing.length > 0;
		const isComplete = dlPresentCount === REQUIRED_2D_FILES.length && glPresentCount === REQUIRED_2D_FILES.length;

		if (isComplete) citiesCompleteBoth++;

		if (hasAnyMissing) {
			missingByCity[slug] = {
				datalake: dlMissing,
				globe: glMissing
			};
		}

		byCity[slug] = {
			slug,
			datalake: dlStatus,
			globe: glStatus,
			missing: {
				datalake: dlMissing,
				globe: glMissing
			},
			datalakePresentCount: dlPresentCount,
			globePresentCount: glPresentCount,
			hasAnyMissing,
			isComplete
		};
	}

	const missingRegistryObj = {
		generatedAt,
		source,
		totalCities: citySlugs.length,
		filesChecked: REQUIRED_2D_FILES,
		summary: {
			geoDatalake: datalakeTotals,
			globe: globeTotals,
			citiesWithAnyMissing: Object.keys(missingByCity).length,
			citiesCompleteBoth
		},
		missingByCity
	};

	return {
		source,
		generatedAt,
		filesChecked: REQUIRED_2D_FILES,
		totals: {
			datalake: datalakeTotals,
			globe: globeTotals,
			totalCities: citySlugs.length,
			citiesCompleteBoth,
			citiesWithAnyMissing: Object.keys(missingByCity).length
		},
		byCity,
		missingRegistryJson: JSON.stringify(missingRegistryObj, null, 2)
	};
}

/**
 * Load 2D storage status for all cities.
 */
export async function loadAtlas2DStorageReport(
	platform: any,
	citySlugs: string[]
): Promise<Atlas2DStorageReport> {
	// 1. Try Live R2 Listing via native bindings if available
	const datalakeBucket = platform?.env?.DATALAKE as R2Bucket | undefined;
	const globeBucket = platform?.env?.GLOBE as R2Bucket | undefined;

	if (datalakeBucket && globeBucket) {
		try {
			const [dlList, glList] = await Promise.all([
				listAllR2Keys(datalakeBucket, 'sources/osm/places/'),
				listAllR2Keys(globeBucket, 'data/')
			]);
			const dlSet = new Set(dlList);
			const glSet = new Set(glList);
			return buildReportFromSets(dlSet, glSet, citySlugs, 'live-r2');
		} catch (e) {
			console.warn('[atlas-2d-storage] Live R2 list failed, falling back:', e);
		}
	}

	// 2. Try Reading Stored Registry from GLOBE or DATALAKE or Seed
	if (globeBucket) {
		try {
			const regObj = await globeBucket.get(REGISTRY_R2_KEY);
			if (regObj) {
				const data = (await regObj.json()) as any;
				if (data && data.missingByCity) {
					return parseRegistryJson(data, citySlugs, 'registry-cache');
				}
			}
		} catch (e) {
			console.warn('[atlas-2d-storage] R2 registry read failed:', e);
		}
	}

	// 3. Fall back to bundled seed
	return parseRegistryJson(fallbackSeed, citySlugs, 'bundled-seed');
}

/**
 * Re-construct report from saved registry JSON structure.
 */
function parseRegistryJson(
	registryData: any,
	citySlugs: string[],
	source: 'registry-cache' | 'bundled-seed'
): Atlas2DStorageReport {
	const dlKeys = new Set<string>();
	const glKeys = new Set<string>();

	if (Array.isArray(registryData.cities)) {
		for (const c of registryData.cities) {
			const slug = c.slug;
			for (const file of REQUIRED_2D_FILES) {
				if (c.datalake?.[file]) dlKeys.add(`sources/osm/places/${slug}/${file}`);
				if (c.globe?.[file]) glKeys.add(`data/${slug}-2d/${file}`);
			}
		}
	} else if (registryData.missingByCity) {
		// All assumed present except what's in missingByCity
		const missing = registryData.missingByCity;
		for (const slug of citySlugs) {
			const dlMiss = new Set(missing[slug]?.datalake ?? []);
			const glMiss = new Set(missing[slug]?.globe ?? []);
			for (const file of REQUIRED_2D_FILES) {
				if (!dlMiss.has(file)) dlKeys.add(`sources/osm/places/${slug}/${file}`);
				if (!glMiss.has(file)) glKeys.add(`data/${slug}-2d/${file}`);
			}
		}
	}

	return buildReportFromSets(
		dlKeys,
		glKeys,
		citySlugs,
		source,
		registryData.generatedAt ?? new Date().toISOString()
	);
}

/**
 * Save the missing files registry JSON back to R2.
 */
export async function saveMissingRegistryToR2(
	platform: any,
	registryJson: string
): Promise<{ ok: boolean; savedKeys?: string[]; error?: string }> {
	const globeBucket = platform?.env?.GLOBE as R2Bucket | undefined;
	const datalakeBucket = platform?.env?.DATALAKE as R2Bucket | undefined;

	if (!globeBucket && !datalakeBucket) {
		return { ok: false, error: 'Neither GLOBE nor DATALAKE bucket is bound on this platform.' };
	}

	const savedKeys: string[] = [];
	try {
		const puts: Promise<any>[] = [];
		if (globeBucket) {
			puts.push(
				globeBucket.put(REGISTRY_R2_KEY, registryJson, {
					httpMetadata: { contentType: 'application/json' }
				}).then(() => savedKeys.push(`globe/${REGISTRY_R2_KEY}`))
			);
			puts.push(
				globeBucket.put('data/atlas-2d-missing-files.json', registryJson, {
					httpMetadata: { contentType: 'application/json' }
				}).then(() => savedKeys.push('globe/data/atlas-2d-missing-files.json'))
			);
		}
		if (datalakeBucket) {
			puts.push(
				datalakeBucket.put(REGISTRY_R2_KEY, registryJson, {
					httpMetadata: { contentType: 'application/json' }
				}).then(() => savedKeys.push(`geo-datalake/${REGISTRY_R2_KEY}`))
			);
		}
		await Promise.all(puts);
		return { ok: true, savedKeys };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}
