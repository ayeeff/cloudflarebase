import { serverError } from '$lib/server/agents';
import {
	loadAtlas19StorageReport,
	save19RegistryToR2,
	ALL_19_FILES,
	FILE_CATEGORIES,
	type City19Storage
} from '$lib/server/atlas-19-files-storage';
import seedRegistry from '$lib/data/atlas-2d-missing-files.json';
import cityQid from '$lib/data/city-qid.json';
import type { PageServerLoad, Actions } from './$types';

interface CityEntry {
	name: string;
	slug: string;
	prefix: string;
	country: string;
	continent: string;
	pop: number;
	storage19?: City19Storage;
}

export const load: PageServerLoad = async ({ platform }) => {
	// 1. Gather all registered cities from seed / manifest
	const rawCities = (seedRegistry as any).cities || [];
	const cityList: CityEntry[] = [];
	const citySlugs: string[] = [];

	if (Array.isArray(rawCities)) {
		for (const c of rawCities) {
			const slug = c.slug ? String(c.slug).replace(/-city-atlas$/, '') : '';
			if (!slug || slug === 'newyorkcity') continue;
			citySlugs.push(slug);
			const qidInfo = (cityQid as Record<string, any>)[slug] || (cityQid as Record<string, any>)[slug.replace(/-/g, '')];
			cityList.push({
				name: c.name || qidInfo?.municipality || slug.charAt(0).toUpperCase() + slug.slice(1),
				slug,
				prefix: slug,
				country: c.country || qidInfo?.country || 'Global',
				continent: c.continent || qidInfo?.continent || 'Global',
				pop: c.pop || qidInfo?.pop || 0
			});
		}
	}

	// 2. Load 19-files storage report
	const report = await loadAtlas19StorageReport(platform, citySlugs);

	// 3. Attach per-city storage records
	for (const city of cityList) {
		const s = city.slug.toLowerCase();
		city.storage19 = report.byCity[city.slug] || report.byCity[s] || report.byCity[s.replace(/-/g, '')] || report.byCity[s.replace(/(\w+)-city$/, '$1')];
		const qidInfo = (cityQid as Record<string, any>)[city.slug] || (cityQid as Record<string, any>)[s] || (cityQid as Record<string, any>)[s.replace(/-/g, '')];
		if (!city.pop && qidInfo?.pop) city.pop = Number(qidInfo.pop);
		if ((!city.country || city.country === 'Global') && qidInfo?.country) city.country = qidInfo.country;
		if ((!city.continent || city.continent === 'Global') && qidInfo?.continent) city.continent = qidInfo.continent;
		if (report.byCity[city.slug]?.country && (!city.country || city.country === 'Global')) city.country = report.byCity[city.slug].country;
	}

	cityList.sort((a, b) => (b.pop || 0) - (a.pop || 0) || a.name.localeCompare(b.name));

	return {
		totalCities: cityList.length,
		cities: cityList,
		report,
		allFiles: ALL_19_FILES,
		categories: FILE_CATEGORIES,
		loadedAt: new Date().toISOString()
	};
};

export const actions: Actions = {
	saveRegistry: async ({ platform }) => {
		try {
			const rawCities = (seedRegistry as any).cities || [];
			const citySlugs = rawCities.map((c: any) => String(c.slug).replace(/-city-atlas$/, ''));
			const report = await loadAtlas19StorageReport(platform, citySlugs);
			const ok = await save19RegistryToR2(platform, report);
			return { success: ok };
		} catch (err: any) {
			return { success: false, error: err.message };
		}
	}
};
