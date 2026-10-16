// src/routes/(app)/dashboard/[projectId]/content/layer-json-dashboard/+page.server.ts
import { loadLayerJsonReport, saveLayerJsonRegistryToR2, LAYER_JSON_FILES } from '$lib/server/layer-json-storage';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	const report = await loadLayerJsonReport(platform);

	return {
		report,
		layers: LAYER_JSON_FILES,
		loadedAt: new Date().toISOString()
	};
};

export const actions: Actions = {
	saveRegistry: async ({ platform }) => {
		try {
			const report = await loadLayerJsonReport(platform);
			const ok = await saveLayerJsonRegistryToR2(platform, report);
			return { success: ok };
		} catch (err: any) {
			return { success: false, error: err.message };
		}
	}
};
