// src/lib/server/portal-json-storage.ts
//
// Storage report and presence tracking for all Global Portal JSON datasets
// across Cloudflare R2 (globe/portal/data/...).

import seedData from '$lib/data/portal-categories-seed.json';

export interface PortalSubfolderDef {
	name: string;
	path: string;
	fileCount: number;
}

export interface PortalRootFileDef {
	name: string;
	path: string;
}

export interface PortalCategorySeed {
	id: string;
	name: string;
	subfoldersCount: number;
	filesCount: number;
	totalFiles: number;
	subfolders: PortalSubfolderDef[];
	rootFiles: PortalRootFileDef[];
}

export interface PortalCategoryStorage {
	id: string;
	name: string;
	subfoldersCount: number;
	filesCount: number;
	totalFiles: number;
	presentFilesCount: number;
	missingFilesCount: number;
	isComplete: boolean;
	r2Prefix: string;
	subfolders: Array<{
		name: string;
		path: string;
		expectedFiles: number;
		presentFiles: number;
		isComplete: boolean;
	}>;
	rootFiles: Array<{
		name: string;
		path: string;
		present: boolean;
	}>;
}

export interface PortalStorageReport {
	source: 'live-r2' | 'registry-cache' | 'derived-inventory';
	generatedAt: string;
	totals: {
		totalCategories: number;
		totalExpectedFiles: number;
		totalPresentFiles: number;
		totalMissingFiles: number;
		categoriesComplete: number;
		categoriesWithMissing: number;
	};
	categories: PortalCategoryStorage[];
}

const REGISTRY_PORTAL_KEY = 'registry/portal-json-registry.json';

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

export function buildPortalReportFromKeys(
	keys: Set<string>,
	source: 'live-r2' | 'registry-cache' | 'derived-inventory' = 'derived-inventory'
): PortalStorageReport {
	const seedCats = (seedData as any).categories as PortalCategorySeed[];
	const categories: PortalCategoryStorage[] = [];

	let totalExpectedFiles = 0;
	let totalPresentFiles = 0;
	let categoriesComplete = 0;
	let categoriesWithMissing = 0;

	for (const cat of seedCats) {
		const catPrefix = `portal/data/${cat.id}/`;
		let catPresent = 0;

		const subfolders = (cat.subfolders || []).map((sub) => {
			const subPrefix = `${catPrefix}${sub.path}/`;
			let subPresent = 0;

			if (keys.size === 0) {
				// No live keys loaded yet
				subPresent = 0;
			} else {
				for (const k of keys) {
					if (k.startsWith(subPrefix)) subPresent++;
				}
			}

			catPresent += subPresent;
			return {
				name: sub.name,
				path: sub.path,
				expectedFiles: sub.fileCount,
				presentFiles: subPresent,
				isComplete: subPresent >= sub.fileCount && sub.fileCount > 0
			};
		});

		const rootFiles = (cat.rootFiles || []).map((rf) => {
			const fileKey = `${catPrefix}${rf.path}`;
			const present = keys.has(fileKey);
			if (present) catPresent++;
			return {
				name: rf.name,
				path: rf.path,
				present
			};
		});

		totalExpectedFiles += cat.totalFiles;
		totalPresentFiles += catPresent;

		const isComplete = catPresent >= cat.totalFiles && cat.totalFiles > 0;
		if (isComplete) categoriesComplete++;
		else categoriesWithMissing++;

		categories.push({
			id: cat.id,
			name: cat.name,
			subfoldersCount: cat.subfoldersCount,
			filesCount: cat.filesCount,
			totalFiles: cat.totalFiles,
			presentFilesCount: catPresent,
			missingFilesCount: Math.max(0, cat.totalFiles - catPresent),
			isComplete,
			r2Prefix: catPrefix,
			subfolders,
			rootFiles
		});
	}

	return {
		source,
		generatedAt: new Date().toISOString(),
		totals: {
			totalCategories: categories.length,
			totalExpectedFiles,
			totalPresentFiles,
			totalMissingFiles: Math.max(0, totalExpectedFiles - totalPresentFiles),
			categoriesComplete,
			categoriesWithMissing
		},
		categories
	};
}

export async function loadPortalStorageReport(platform: any): Promise<PortalStorageReport> {
	const env = platform?.env;
	const globe: R2Bucket | undefined = env?.GLOBE;

	// 1. Try reading R2 cached registry
	if (globe) {
		try {
			const cached = await globe.get(REGISTRY_PORTAL_KEY);
			if (cached) {
				const json = (await cached.json()) as any;
				if (json && json.totals && Array.isArray(json.categories)) {
					return {
						source: 'registry-cache',
						generatedAt: json.generatedAt || new Date().toISOString(),
						totals: json.totals,
						categories: json.categories
					};
				}
			}
		} catch {
			/* fallback to live scan */
		}
	}

	// 2. Live scan if bucket bound
	if (globe) {
		try {
			const keys = await listAllKeys(globe, 'portal/data/');
			return buildPortalReportFromKeys(keys, 'live-r2');
		} catch {
			/* fallback to seed */
		}
	}

	// 3. Fallback
	return buildPortalReportFromKeys(new Set(), 'derived-inventory');
}

export async function savePortalRegistryToR2(platform: any, report: PortalStorageReport): Promise<boolean> {
	const env = platform?.env;
	const globe: R2Bucket | undefined = env?.GLOBE;
	if (!globe) return false;

	try {
		await globe.put(REGISTRY_PORTAL_KEY, JSON.stringify(report, null, 2), {
			httpMetadata: { contentType: 'application/json' }
		});
		return true;
	} catch {
		return false;
	}
}
