import {
	loadInfoboxStorageReport,
	saveInfoboxRegistryToR2,
	type InfoboxCityStorage
} from '$lib/server/infobox-json-storage';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	const report = await loadInfoboxStorageReport(platform);
	const cities: InfoboxCityStorage[] = Object.values(report.byCity);

	cities.sort((a, b) => (b.hasInfobox ? 1 : 0) - (a.hasInfobox ? 1 : 0) || (b.pop || 0) - (a.pop || 0) || a.name.localeCompare(b.name));

	return {
		totalCities: cities.length,
		cities,
		report,
		loadedAt: new Date().toISOString()
	};
};

export const actions: Actions = {
	saveRegistry: async ({ platform }) => {
		try {
			const report = await loadInfoboxStorageReport(platform);
			const ok = await saveInfoboxRegistryToR2(platform, report);
			return { success: ok };
		} catch (err: any) {
			return { success: false, error: err.message };
		}
	}
};
