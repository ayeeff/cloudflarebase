import {
	loadGuideStorageReport,
	saveGuideRegistryToR2,
	GUIDE_STANDARD_FILES,
	GUIDE_FILE_CATEGORIES,
	type GuideCityStorage
} from '$lib/server/guide-json-storage';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	const report = await loadGuideStorageReport(platform);
	const guides: GuideCityStorage[] = Object.values(report.byGuide);

	guides.sort((a, b) => (b.pop || 0) - (a.pop || 0) || a.name.localeCompare(b.name));

	return {
		totalGuides: guides.length,
		guides,
		report,
		allFiles: GUIDE_STANDARD_FILES,
		categories: GUIDE_FILE_CATEGORIES,
		loadedAt: new Date().toISOString()
	};
};

export const actions: Actions = {
	saveRegistry: async ({ platform }) => {
		try {
			const report = await loadGuideStorageReport(platform);
			const ok = await saveGuideRegistryToR2(platform, report);
			return { success: ok };
		} catch (err: any) {
			return { success: false, error: err.message };
		}
	}
};
