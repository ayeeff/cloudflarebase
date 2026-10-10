import { loadAtlasThemesReport, saveAtlasThemesRegistryToR2, ATLAS_THEMES } from '$lib/server/atlas-themes-storage';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	const report = await loadAtlasThemesReport(platform);

	return {
		report,
		themes: ATLAS_THEMES,
		loadedAt: new Date().toISOString()
	};
};

export const actions: Actions = {
	saveRegistry: async ({ platform }) => {
		try {
			const report = await loadAtlasThemesReport(platform);
			const ok = await saveAtlasThemesRegistryToR2(platform, report);
			return { success: ok };
		} catch (err: any) {
			return { success: false, error: err.message };
		}
	}
};
