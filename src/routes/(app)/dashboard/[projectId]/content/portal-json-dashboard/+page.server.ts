import {
	loadPortalStorageReport,
	savePortalRegistryToR2
} from '$lib/server/portal-json-storage';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	const report = await loadPortalStorageReport(platform);

	return {
		report,
		categories: report.categories,
		loadedAt: new Date().toISOString()
	};
};

export const actions: Actions = {
	saveRegistry: async ({ platform }) => {
		try {
			const report = await loadPortalStorageReport(platform);
			const ok = await savePortalRegistryToR2(platform, report);
			return { success: ok };
		} catch (err: any) {
			return { success: false, error: err.message };
		}
	}
};
