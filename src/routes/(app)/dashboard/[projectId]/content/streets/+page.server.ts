import { geoAstroFetch } from '$lib/server/geo-astro';
import type { PageServerLoad } from './$types';

const GEO_ASTRO_BASE = 'https://geo-astro-site.foodstarmelbourne.workers.dev';

export interface StreetRegionStats {
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

export const REGIONAL_STREET_STATS: StreetRegionStats[] = [
	{
		region: 'United States (US)',
		countryCode: 'US',
		uniqueStreets: '~14,000,000',
		streetsCount: 14000000,
		parquetSize: '193.1 MB',
		sizeBytes: 197703 * 1024,
		rawDoorPoints: '125.8M points',
		compressionRatio: '~97.4%',
		status: 'live',
		primaryCities: ['New York', 'Los Angeles', 'Chicago', 'San Francisco', 'Miami', 'Seattle'],
		partitionKey: 'sources/addresses/street_postcode_city/country=US/data_0.parquet'
	},
	{
		region: 'Brazil (BR)',
		countryCode: 'BR',
		uniqueStreets: '~9,500,000',
		streetsCount: 9500000,
		parquetSize: '114.3 MB',
		sizeBytes: 117070 * 1024,
		rawDoorPoints: '89.9M points',
		compressionRatio: '~97.1%',
		status: 'live',
		primaryCities: ['São Paulo', 'Rio de Janeiro', 'Brasília', 'Salvador', 'Belo Horizonte', 'Curitiba'],
		partitionKey: 'sources/addresses/street_postcode_city/country=BR/data_0.parquet'
	},
	{
		region: 'France (FR)',
		countryCode: 'FR',
		uniqueStreets: '~1,200,000',
		streetsCount: 1200000,
		parquetSize: '81.2 MB',
		sizeBytes: 81201 * 1024,
		rawDoorPoints: '26.1M points',
		compressionRatio: '~96.8%',
		status: 'live',
		primaryCities: ['Paris', 'Lyon', 'Marseille', 'Toulouse', 'Nice', 'Bordeaux'],
		partitionKey: 'sources/addresses/street_postcode_city/country=FR/data_0.parquet'
	},
	{
		region: 'Canada (CA)',
		countryCode: 'CA',
		uniqueStreets: '~950,000',
		streetsCount: 950000,
		parquetSize: '35.9 MB',
		sizeBytes: 35863 * 1024,
		rawDoorPoints: '16.9M points',
		compressionRatio: '~97.1%',
		status: 'live',
		primaryCities: ['Toronto', 'Vancouver', 'Montreal', 'Calgary', 'Ottawa', 'Edmonton'],
		partitionKey: 'sources/addresses/street_postcode_city/country=CA/data_0.parquet'
	},
	{
		region: 'Spain (ES)',
		countryCode: 'ES',
		uniqueStreets: '~900,000',
		streetsCount: 900000,
		parquetSize: '34.0 MB',
		sizeBytes: 33952 * 1024,
		rawDoorPoints: '15.6M points',
		compressionRatio: '~96.7%',
		status: 'live',
		primaryCities: ['Madrid', 'Barcelona', 'Valencia', 'Seville', 'Zaragoza', 'Málaga'],
		partitionKey: 'sources/addresses/street_postcode_city/country=ES/data_0.parquet'
	},
	{
		region: 'Mexico (MX)',
		countryCode: 'MX',
		uniqueStreets: '~1,800,000',
		streetsCount: 1800000,
		parquetSize: '31.8 MB',
		sizeBytes: 31843 * 1024,
		rawDoorPoints: '30.7M points',
		compressionRatio: '~97.0%',
		status: 'live',
		primaryCities: ['Mexico City', 'Guadalajara', 'Monterrey', 'Puebla', 'Tijuana', 'Cancún'],
		partitionKey: 'sources/addresses/street_postcode_city/country=MX/data_0.parquet'
	},
	{
		region: 'Italy (IT)',
		countryCode: 'IT',
		uniqueStreets: '~900,000',
		streetsCount: 900000,
		parquetSize: '19.7 MB',
		sizeBytes: 19700 * 1024,
		rawDoorPoints: '25.9M points',
		compressionRatio: '~96.6%',
		status: 'live',
		primaryCities: ['Rome', 'Milan', 'Naples', 'Turin', 'Palermo', 'Florence'],
		partitionKey: 'sources/addresses/street_postcode_city/country=IT/data_0.parquet'
	},
	{
		region: 'Portugal (PT)',
		countryCode: 'PT',
		uniqueStreets: '~400,000',
		streetsCount: 400000,
		parquetSize: '17.1 MB',
		sizeBytes: 17112 * 1024,
		rawDoorPoints: '5.6M points',
		compressionRatio: '~96.5%',
		status: 'live',
		primaryCities: ['Lisbon', 'Porto', 'Braga', 'Coimbra', 'Funchal', 'Faro'],
		partitionKey: 'sources/addresses/street_postcode_city/country=PT/data_0.parquet'
	},
	{
		region: 'Australia (AU)',
		countryCode: 'AU',
		uniqueStreets: '~1,100,000',
		streetsCount: 1100000,
		parquetSize: '16.3 MB',
		sizeBytes: 16332 * 1024,
		rawDoorPoints: '15.7M points',
		compressionRatio: '~97.2%',
		status: 'live',
		primaryCities: ['Melbourne', 'Sydney', 'Brisbane', 'Perth', 'Adelaide', 'Gold Coast'],
		partitionKey: 'sources/addresses/street_postcode_city/country=AU/data_0.parquet'
	},
	{
		region: 'Netherlands (NL)',
		countryCode: 'NL',
		uniqueStreets: '~600,000',
		streetsCount: 600000,
		parquetSize: '15.3 MB',
		sizeBytes: 15325 * 1024,
		rawDoorPoints: '9.9M points',
		compressionRatio: '~96.9%',
		status: 'live',
		primaryCities: ['Amsterdam', 'Rotterdam', 'The Hague', 'Utrecht', 'Eindhoven', 'Groningen'],
		partitionKey: 'sources/addresses/street_postcode_city/country=NL/data_0.parquet'
	},
	{
		region: 'United Kingdom (GB)',
		countryCode: 'GB',
		uniqueStreets: '~1,400,000',
		streetsCount: 1400000,
		parquetSize: '14.1 MB',
		sizeBytes: 14053 * 1024,
		rawDoorPoints: '28M points (OS Open Names)',
		compressionRatio: '~96.9%',
		status: 'live',
		primaryCities: ['London', 'Manchester', 'Birmingham', 'Edinburgh', 'Glasgow', 'Bristol'],
		partitionKey: 'sources/addresses/street_postcode_city/country=GB/data_0.parquet'
	},
	{
		region: 'Finland (FI)',
		countryCode: 'FI',
		uniqueStreets: '~450,000',
		streetsCount: 450000,
		parquetSize: '8.3 MB',
		sizeBytes: 8311 * 1024,
		rawDoorPoints: '3.7M points',
		compressionRatio: '~96.8%',
		status: 'live',
		primaryCities: ['Helsinki', 'Espoo', 'Tampere', 'Vantaa', 'Oulu', 'Turku'],
		partitionKey: 'sources/addresses/street_postcode_city/country=FI/data_0.parquet'
	},
	{
		region: 'Poland (PL)',
		countryCode: 'PL',
		uniqueStreets: '~700,000',
		streetsCount: 700000,
		parquetSize: '7.5 MB',
		sizeBytes: 7504 * 1024,
		rawDoorPoints: '8.6M points',
		compressionRatio: '~96.9%',
		status: 'live',
		primaryCities: ['Warsaw', 'Kraków', 'Łódź', 'Wrocław', 'Poznań', 'Gdańsk'],
		partitionKey: 'sources/addresses/street_postcode_city/country=PL/data_0.parquet'
	},
	{
		region: 'Switzerland (CH)',
		countryCode: 'CH',
		uniqueStreets: '~350,000',
		streetsCount: 350000,
		parquetSize: '5.9 MB',
		sizeBytes: 5880 * 1024,
		rawDoorPoints: '3.3M points',
		compressionRatio: '~96.7%',
		status: 'live',
		primaryCities: ['Zurich', 'Geneva', 'Basel', 'Lausanne', 'Bern', 'Lucerne'],
		partitionKey: 'sources/addresses/street_postcode_city/country=CH/data_0.parquet'
	},
	{
		region: 'Taiwan (TW)',
		countryCode: 'TW',
		uniqueStreets: '~600,000',
		streetsCount: 600000,
		parquetSize: '5.5 MB',
		sizeBytes: 5481 * 1024,
		rawDoorPoints: '9.7M points',
		compressionRatio: '~97.1%',
		status: 'live',
		primaryCities: ['Taipei', 'Kaohsiung', 'Taichung', 'Tainan', 'Taoyuan', 'Hsinchu'],
		partitionKey: 'sources/addresses/street_postcode_city/country=TW/data_0.parquet'
	},
	{
		region: 'Colombia (CO)',
		countryCode: 'CO',
		uniqueStreets: '~550,000',
		streetsCount: 550000,
		parquetSize: '5.4 MB',
		sizeBytes: 5398 * 1024,
		rawDoorPoints: '7.8M points',
		compressionRatio: '~96.9%',
		status: 'live',
		primaryCities: ['Bogotá', 'Medellín', 'Cali', 'Barranquilla', 'Cartagena', 'Cúcuta'],
		partitionKey: 'sources/addresses/street_postcode_city/country=CO/data_0.parquet'
	},
	{
		region: 'Germany (DE)',
		countryCode: 'DE',
		uniqueStreets: '~1,300,000',
		streetsCount: 1300000,
		parquetSize: '5.1 MB',
		sizeBytes: 5077 * 1024,
		rawDoorPoints: '19.3M points',
		compressionRatio: '~97.0%',
		status: 'live',
		primaryCities: ['Berlin', 'Munich', 'Hamburg', 'Frankfurt', 'Cologne', 'Stuttgart'],
		partitionKey: 'sources/addresses/street_postcode_city/country=DE/data_0.parquet'
	},
	{
		region: 'Japan (JP)',
		countryCode: 'JP',
		uniqueStreets: '~850,000',
		streetsCount: 850000,
		parquetSize: '4.4 MB',
		sizeBytes: 4394 * 1024,
		rawDoorPoints: '19.6M points',
		compressionRatio: '~97.2%',
		status: 'live',
		primaryCities: ['Tokyo', 'Yokohama', 'Osaka', 'Nagoya', 'Sapporo', 'Kyoto'],
		partitionKey: 'sources/addresses/street_postcode_city/country=JP/data_0.parquet'
	},
	{
		region: 'Belgium (BE)',
		countryCode: 'BE',
		uniqueStreets: '~380,000',
		streetsCount: 380000,
		parquetSize: '4.2 MB',
		sizeBytes: 4243 * 1024,
		rawDoorPoints: '6.7M points',
		compressionRatio: '~96.8%',
		status: 'live',
		primaryCities: ['Brussels', 'Antwerp', 'Ghent', 'Charleroi', 'Liège', 'Bruges'],
		partitionKey: 'sources/addresses/street_postcode_city/country=BE/data_0.parquet'
	},
	{
		region: 'Austria (AT)',
		countryCode: 'AT',
		uniqueStreets: '~350,000',
		streetsCount: 350000,
		parquetSize: '4.1 MB',
		sizeBytes: 4116 * 1024,
		rawDoorPoints: '2.5M points',
		compressionRatio: '~96.7%',
		status: 'live',
		primaryCities: ['Vienna', 'Graz', 'Linz', 'Salzburg', 'Innsbruck', 'Klagenfurt'],
		partitionKey: 'sources/addresses/street_postcode_city/country=AT/data_0.parquet'
	},
	{
		region: 'Chile (CL)',
		countryCode: 'CL',
		uniqueStreets: '~320,000',
		streetsCount: 320000,
		parquetSize: '3.7 MB',
		sizeBytes: 3656 * 1024,
		rawDoorPoints: '4.2M points',
		compressionRatio: '~96.6%',
		status: 'live',
		primaryCities: ['Santiago', 'Valparaíso', 'Concepción', 'La Serena', 'Antofagasta', 'Temuco'],
		partitionKey: 'sources/addresses/street_postcode_city/country=CL/data_0.parquet'
	},
	{
		region: 'Norway (NO)',
		countryCode: 'NO',
		uniqueStreets: '~300,000',
		streetsCount: 300000,
		parquetSize: '3.4 MB',
		sizeBytes: 3417 * 1024,
		rawDoorPoints: '3.6M points',
		compressionRatio: '~96.8%',
		status: 'live',
		primaryCities: ['Oslo', 'Bergen', 'Trondheim', 'Stavanger', 'Bærum', 'Kristiansand'],
		partitionKey: 'sources/addresses/street_postcode_city/country=NO/data_0.parquet'
	},
	{
		region: 'Denmark (DK)',
		countryCode: 'DK',
		uniqueStreets: '~280,000',
		streetsCount: 280000,
		parquetSize: '3.0 MB',
		sizeBytes: 3011 * 1024,
		rawDoorPoints: '3.9M points',
		compressionRatio: '~96.7%',
		status: 'live',
		primaryCities: ['Copenhagen', 'Aarhus', 'Odense', 'Aalborg', 'Frederiksberg', 'Esbjerg'],
		partitionKey: 'sources/addresses/street_postcode_city/country=DK/data_0.parquet'
	},
	{
		region: 'Serbia (RS)',
		countryCode: 'RS',
		uniqueStreets: '~250,000',
		streetsCount: 250000,
		parquetSize: '3.0 MB',
		sizeBytes: 2958 * 1024,
		rawDoorPoints: '2.7M points',
		compressionRatio: '~96.6%',
		status: 'live',
		primaryCities: ['Belgrade', 'Novi Sad', 'Niš', 'Kragujevac', 'Subotica', 'Zrenjanin'],
		partitionKey: 'sources/addresses/street_postcode_city/country=RS/data_0.parquet'
	},
	{
		region: 'Singapore (SG)',
		countryCode: 'SG',
		uniqueStreets: '~30,000',
		streetsCount: 30000,
		parquetSize: '2.4 MB',
		sizeBytes: 2427 * 1024,
		rawDoorPoints: '142K points',
		compressionRatio: '~96.4%',
		status: 'live',
		primaryCities: ['Singapore', 'Jurong', 'Woodlands', 'Tampines', 'Bedok', 'Orchard'],
		partitionKey: 'sources/addresses/street_postcode_city/country=SG/data_0.parquet'
	},
	{
		region: 'Czechia (CZ)',
		countryCode: 'CZ',
		uniqueStreets: '~240,000',
		streetsCount: 240000,
		parquetSize: '2.4 MB',
		sizeBytes: 2419 * 1024,
		rawDoorPoints: '3.0M points',
		compressionRatio: '~96.7%',
		status: 'live',
		primaryCities: ['Prague', 'Brno', 'Ostrava', 'Plzeň', 'Liberec', 'Olomouc'],
		partitionKey: 'sources/addresses/street_postcode_city/country=CZ/data_0.parquet'
	},
	{
		region: 'New Zealand (NZ)',
		countryCode: 'NZ',
		uniqueStreets: '~180,000',
		streetsCount: 180000,
		parquetSize: '2.4 MB',
		sizeBytes: 2356 * 1024,
		rawDoorPoints: '2.4M points',
		compressionRatio: '~96.8%',
		status: 'live',
		primaryCities: ['Auckland', 'Wellington', 'Christchurch', 'Hamilton', 'Tauranga', 'Dunedin'],
		partitionKey: 'sources/addresses/street_postcode_city/country=NZ/data_0.parquet'
	},
	{
		region: 'Lithuania (LT)',
		countryCode: 'LT',
		uniqueStreets: '~160,000',
		streetsCount: 160000,
		parquetSize: '2.2 MB',
		sizeBytes: 2194 * 1024,
		rawDoorPoints: '1.1M points',
		compressionRatio: '~96.6%',
		status: 'live',
		primaryCities: ['Vilnius', 'Kaunas', 'Klaipėda', 'Šiauliai', 'Panevėžys', 'Alytus'],
		partitionKey: 'sources/addresses/street_postcode_city/country=LT/data_0.parquet'
	},
	{
		region: 'Croatia (HR)',
		countryCode: 'HR',
		uniqueStreets: '~150,000',
		streetsCount: 150000,
		parquetSize: '2.1 MB',
		sizeBytes: 2078 * 1024,
		rawDoorPoints: '1.7M points',
		compressionRatio: '~96.6%',
		status: 'live',
		primaryCities: ['Zagreb', 'Split', 'Rijeka', 'Osijek', 'Zadar', 'Dubrovnik'],
		partitionKey: 'sources/addresses/street_postcode_city/country=HR/data_0.parquet'
	},
	{
		region: 'Central Europe, Nordics & Global Territories (11 Countries)',
		countryCode: 'SK,UY,IS,LV,SI,EE,LU,HK,FO,LI,GL',
		uniqueStreets: '~850,000 combined',
		streetsCount: 850000,
		parquetSize: '4.6 MB combined',
		sizeBytes: 4600 * 1024,
		rawDoorPoints: '~5.5M points combined',
		compressionRatio: '~96.6%',
		status: 'live',
		primaryCities: ['Bratislava (SK)', 'Montevideo (UY)', 'Reykjavik (IS)', 'Riga (LV)', 'Ljubljana (SI)', 'Tallinn (EE)', 'Luxembourg (LU)', 'Hong Kong (HK)'],
		partitionKey: 'sources/addresses/street_postcode_city/country={SK,UY,IS,LV,SI,EE,LU,HK,FO,LI,GL}/*.parquet'
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
			totalStreetsApprox: '~40,000,000+',
			totalSizeMB,
			totalSizeGB: (totalSizeMB / 1024).toFixed(2),
			totalCountries: '40 Countries (100% Ingested)',
			bucket: 'geo-datalake',
			prefix: 'sources/addresses/street_postcode_city/',
			freeTierLimit: '660 MB total (Zero Cloudflare Storage Cost)',
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
