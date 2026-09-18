import { geoAstroFetch } from '$lib/server/geo-astro';
import type { PageServerLoad } from './$types';

const GEO_ASTRO_BASE = 'https://geo-astro-site.foodstarmelbourne.workers.dev';

interface StreetRegionStats {
	region: string;
	countryCode: string;
	uniqueStreets: string;
	streetsCount: number;
	parquetSize: string;
	sizeBytes: number;
	rawDoorPoints: string;
	compressionRatio: string;
	status: 'live' | 'syncing' | 'queued';
	primaryCities: string[];
	partitionKey: string;
}

const REGIONAL_STREET_STATS: StreetRegionStats[] = [
	{
		region: 'United States (US)',
		countryCode: 'US',
		uniqueStreets: '~14,000,000',
		streetsCount: 14000000,
		parquetSize: '~480 MB',
		sizeBytes: 480 * 1024 * 1024,
		rawDoorPoints: '~185M points',
		compressionRatio: '~97.4%',
		status: 'live',
		primaryCities: ['New York', 'Los Angeles', 'Chicago', 'San Francisco', 'Miami', 'Seattle'],
		partitionKey: 'sources/addresses/street_postcode_city/country=US/*.parquet'
	},
	{
		region: 'Australia (AU)',
		countryCode: 'AU',
		uniqueStreets: '~1,100,000',
		streetsCount: 1100000,
		parquetSize: '~38 MB',
		sizeBytes: 38 * 1024 * 1024,
		rawDoorPoints: '15.7M points',
		compressionRatio: '~97.2%',
		status: 'live',
		primaryCities: ['Melbourne', 'Sydney', 'Brisbane', 'Perth', 'Adelaide', 'Gold Coast'],
		partitionKey: 'sources/addresses/street_postcode_city/country=AU/*.parquet'
	},
	{
		region: 'United Kingdom (GB)',
		countryCode: 'GB',
		uniqueStreets: '~1,400,000',
		streetsCount: 1400000,
		parquetSize: '~48 MB',
		sizeBytes: 48 * 1024 * 1024,
		rawDoorPoints: '~28M points',
		compressionRatio: '~96.9%',
		status: 'live',
		primaryCities: ['London', 'Manchester', 'Birmingham', 'Edinburgh', 'Glasgow', 'Bristol'],
		partitionKey: 'sources/addresses/street_postcode_city/country=GB/*.parquet'
	},
	{
		region: 'France (FR)',
		countryCode: 'FR',
		uniqueStreets: '~1,200,000',
		streetsCount: 1200000,
		parquetSize: '~42 MB',
		sizeBytes: 42 * 1024 * 1024,
		rawDoorPoints: '~24M points',
		compressionRatio: '~96.8%',
		status: 'live',
		primaryCities: ['Paris', 'Lyon', 'Marseille', 'Toulouse', 'Nice', 'Bordeaux'],
		partitionKey: 'sources/addresses/street_postcode_city/country=FR/*.parquet'
	},
	{
		region: 'Germany (DE)',
		countryCode: 'DE',
		uniqueStreets: '~1,300,000',
		streetsCount: 1300000,
		parquetSize: '~45 MB',
		sizeBytes: 45 * 1024 * 1024,
		rawDoorPoints: '~26M points',
		compressionRatio: '~97.0%',
		status: 'live',
		primaryCities: ['Berlin', 'Munich', 'Hamburg', 'Frankfurt', 'Cologne', 'Stuttgart'],
		partitionKey: 'sources/addresses/street_postcode_city/country=DE/*.parquet'
	},
	{
		region: 'Canada (CA)',
		countryCode: 'CA',
		uniqueStreets: '~950,000',
		streetsCount: 950000,
		parquetSize: '~33 MB',
		sizeBytes: 33 * 1024 * 1024,
		rawDoorPoints: '~16M points',
		compressionRatio: '~97.1%',
		status: 'live',
		primaryCities: ['Toronto', 'Vancouver', 'Montreal', 'Calgary', 'Ottawa', 'Edmonton'],
		partitionKey: 'sources/addresses/street_postcode_city/country=CA/*.parquet'
	},
	{
		region: 'Italy (IT) & Spain (ES)',
		countryCode: 'IT,ES',
		uniqueStreets: '~1,800,000 combined',
		streetsCount: 1800000,
		parquetSize: '~62 MB',
		sizeBytes: 62 * 1024 * 1024,
		rawDoorPoints: '~34M points',
		compressionRatio: '~96.6%',
		status: 'live',
		primaryCities: ['Rome', 'Milan', 'Madrid', 'Barcelona', 'Naples', 'Valencia'],
		partitionKey: 'sources/addresses/street_postcode_city/country={IT,ES}/*.parquet'
	},
	{
		region: 'Japan (JP), Singapore (SG), Rest of Asia',
		countryCode: 'JP,SG,ASIA',
		uniqueStreets: '~3,500,000 combined',
		streetsCount: 3500000,
		parquetSize: '~120 MB',
		sizeBytes: 120 * 1024 * 1024,
		rawDoorPoints: '~65M points',
		compressionRatio: '~96.4%',
		status: 'live',
		primaryCities: ['Tokyo', 'Osaka', 'Kyoto', 'Singapore', 'Seoul', 'Taipei', 'Hong Kong'],
		partitionKey: 'sources/addresses/street_postcode_city/country={JP,SG...}/*.parquet'
	},
	{
		region: 'Rest of World (All other 180+ countries)',
		countryCode: 'ROW',
		uniqueStreets: '~10,000,000 combined',
		streetsCount: 10000000,
		parquetSize: '~350 MB',
		sizeBytes: 350 * 1024 * 1024,
		rawDoorPoints: '~150M points',
		compressionRatio: '~96.8%',
		status: 'live',
		primaryCities: ['Global Metros (380+ Cities in Atlas Catalog)'],
		partitionKey: 'sources/addresses/street_postcode_city/country=*/*.parquet'
	}
];

export const load: PageServerLoad = async ({ platform, url }) => {
	const q = (url.searchParams.get('q') ?? '').trim();
	const country = (url.searchParams.get('country') ?? '').trim();

	let searchResults: any[] = [];
	let searchError: string | null = null;
	let searchCount = 0;

	if (q) {
		try {
			const res = await geoAstroFetch(
				platform,
				`/api/street-search.json?q=${encodeURIComponent(q)}${country ? `&country=${encodeURIComponent(country)}` : ''}&limit=12`
			);
			if (res.ok) {
				const json: any = await res.json();
				searchResults = json.results ?? [];
				searchCount = json.count ?? searchResults.length;
			} else {
				searchError = `geo-astro-site responded ${res.status}`;
			}
		} catch (err: any) {
			searchError = err?.message ?? 'Failed to reach street-search API';
		}
	}

	const totalStreets = REGIONAL_STREET_STATS.reduce((acc, r) => acc + r.streetsCount, 0);
	const totalSizeBytes = REGIONAL_STREET_STATS.reduce((acc, r) => acc + r.sizeBytes, 0);
	const totalSizeMB = Math.round(totalSizeBytes / (1024 * 1024));

	return {
		regions: REGIONAL_STREET_STATS,
		summary: {
			totalStreets: totalStreets.toLocaleString(),
			totalStreetsApprox: '~36,250,000+',
			totalSizeMB,
			totalSizeGB: (totalSizeMB / 1024).toFixed(2),
			totalCountries: '190+',
			bucket: 'geo-datalake',
			prefix: 'sources/addresses/street_postcode_city/',
			freeTierLimit: '10 GB (Zero Storage Cost)',
			atlasCitiesCount: '380+'
		},
		search: {
			q,
			country,
			results: searchResults,
			count: searchCount,
			error: searchError
		},
		siteBase: GEO_ASTRO_BASE
	};
};
