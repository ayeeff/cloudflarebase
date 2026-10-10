// src/lib/server/atlas-themes-storage.ts
//
// Tracking presence of 5 Atlas thematic JSON files in R2 bucket (globe):
// 1. transit.json (or metro-train-atlas-data.json)
// 2. worship.json
// 3. schools.json
// 4. property.json
// 5. universities.json

import themesSeed from '$lib/data/atlas-themes-seed.json';
import cityQid from '$lib/data/city-qid.json';

export const ATLAS_THEMES = [
	{
		id: 'metro',
		name: 'Metro Landmarks',
		file: 'metro-train-atlas-data.json',
		altFile: 'transit.json',
		accent: '#fbbf24',
		description: 'Curated hub stations, ridership rankings, lines, and passenger notes'
	},
	{
		id: 'transitStations',
		name: 'Transit Stations',
		file: 'transit-stations.json',
		altFile: null,
		accent: '#c084fc',
		description: 'Local transit stops and smaller secondary stations'
	},
	{
		id: 'transitLines',
		name: 'Transit Routes',
		file: 'transit-lines.json',
		altFile: null,
		accent: '#a855f7',
		description: 'Subway, railway, and tram network line geometry'
	},
	{
		id: 'worship',
		name: 'Places of Worship',
		file: 'worship.json',
		altFile: null,
		accent: '#38bdf8',
		description: 'Churches, cathedrals, temples, mosques and synagogues with faith denominations'
	},
	{
		id: 'schools',
		name: 'Schools & Academies',
		file: 'schools.json',
		altFile: null,
		accent: '#4ade80',
		description: 'Elite academies, public secondary, private, and religious schools'
	},
	{
		id: 'property',
		name: 'Property Districts',
		file: 'property.json',
		altFile: null,
		accent: '#f59e0b',
		description: 'Top residential housing districts and high-value property areas'
	},
	{
		id: 'universities',
		name: 'Universities',
		file: 'universities.json',
		altFile: null,
		accent: '#f472b6',
		description: 'Elite research universities, public, private, and specialist academies'
	}
] as const;

export type AtlasThemeId = (typeof ATLAS_THEMES)[number]['id'];

export interface CityThemeRecord {
	slug: string;
	name: string;
	country: string;
	continent: string;
	pop: number;
	themes: Record<AtlasThemeId, { present: boolean; count?: number }>;
	presentCount: number;
	missingCount: number;
	isComplete: boolean;
}

export interface AtlasThemesReport {
	source: 'registry-cache' | 'live-r2' | 'seed';
	generatedAt: string;
	totalCities: number;
	summary: Record<AtlasThemeId, { present: number; missing: number }>;
	cities: CityThemeRecord[];
}

const THEMES_REGISTRY_KEY = 'registry/atlas-themes-registry.json';

export async function loadAtlasThemesReport(platform: any): Promise<AtlasThemesReport> {
	const env = platform?.env;
	const globe = env?.GLOBE;

	if (globe) {
		try {
			const cached = await globe.get(THEMES_REGISTRY_KEY);
			if (cached) {
				const json = await cached.json() as any;
				if (json && json.cities && json.summary) {
					return json;
				}
			}
		} catch {}
	}

	// Build from seed and cityQid
	const rawCities = (themesSeed as any).cities || [];
	const summary = {} as Record<AtlasThemeId, { present: number; missing: number }>;
	for (const t of ATLAS_THEMES) {
		summary[t.id] = { present: 0, missing: 0 };
	}

	const cities: CityThemeRecord[] = [];

	for (const c of rawCities) {
		const slug = c.slug.toLowerCase();
		const qidInfo = (cityQid as Record<string, any>)[slug] || (cityQid as Record<string, any>)[slug.replace(/-/g, '')];

		const themePresence: Record<AtlasThemeId, { present: boolean }> = {
			metro: Boolean(c.metro),
			transitStations: Boolean(c.transitStations),
			transitLines: Boolean(c.transitLines),
			worship: Boolean(c.worship),
			schools: Boolean(c.schools),
			property: Boolean(c.property),
			universities: Boolean(c.universities)
		};

		let presentCount = 0;
		for (const t of ATLAS_THEMES) {
			if (themePresence[t.id].present) {
				presentCount++;
				summary[t.id].present++;
			} else {
				summary[t.id].missing++;
			}
		}

		cities.push({
			slug,
			name: qidInfo?.municipality || slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' '),
			country: qidInfo?.country || 'Global',
			continent: qidInfo?.continent || 'Global',
			pop: Number(qidInfo?.pop) || 0,
			themes: themePresence,
			presentCount,
			missingCount: ATLAS_THEMES.length - presentCount,
			isComplete: presentCount === ATLAS_THEMES.length
		});
	}

	cities.sort((a, b) => b.pop - a.pop || a.name.localeCompare(b.name));

	return {
		source: 'seed',
		generatedAt: new Date().toISOString(),
		totalCities: cities.length,
		summary,
		cities
	};
}

export async function saveAtlasThemesRegistryToR2(platform: any, report: AtlasThemesReport): Promise<boolean> {
	const env = platform?.env;
	const globe = env?.GLOBE;
	if (!globe) return false;

	try {
		await globe.put(THEMES_REGISTRY_KEY, JSON.stringify(report, null, 2), {
			httpMetadata: { contentType: 'application/json' }
		});
		return true;
	} catch {
		return false;
	}
}
