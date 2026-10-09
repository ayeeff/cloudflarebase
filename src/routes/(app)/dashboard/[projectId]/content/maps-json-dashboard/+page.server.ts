import {
	loadMapsStorageReport,
	saveMapsRegistryToR2,
	MAPS_STANDARD_FILES,
	MAPS_FILE_CATEGORIES,
	type MapDatasetStorage
} from '$lib/server/maps-json-storage';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	const report = await loadMapsStorageReport(platform);
	const maps: MapDatasetStorage[] = Object.values(report.byMap);

	maps.sort((a, b) => (b.featuresCount || 0) - (a.featuresCount || 0) || a.title.localeCompare(b.title));

	return {
		totalMaps: maps.length,
		maps,
		report,
		allFiles: MAPS_STANDARD_FILES,
		categories: MAPS_FILE_CATEGORIES,
		loadedAt: new Date().toISOString()
	};
};

export const actions: Actions = {
	saveRegistry: async ({ platform }) => {
		try {
			const report = await loadMapsStorageReport(platform);
			const ok = await saveMapsRegistryToR2(platform, report);
			return { success: ok };
		} catch (err: any) {
			return { success: false, error: err.message };
		}
	}
};
