/**
 * Edge geography -> Durable Object location hint, for routing replicated
 * reads to the caller's region replica. Wrong-but-close is acceptable by
 * design: hints are best-effort placement, and a misrouted read is merely a
 * longer hop, never wrong data. Pure module, unit-tested.
 *
 * Hints: wnam enam sam weur eeur apac apac-ne apac-se oc afr me
 * (v1 uses the coarse `apac` rather than -ne/-se; revisit with traffic).
 */

export interface EdgeGeo {
	/** request.cf.continent: AF AN AS EU NA OC SA */
	continent?: string;
	/** request.cf.country, ISO 3166-1 alpha-2. */
	country?: string;
	/** request.cf.longitude - a stringified float. */
	longitude?: string | number;
}

/** ISO countries the platform's `me` hint serves better than `apac`. */
const MIDDLE_EAST = new Set([
	'AE',
	'BH',
	'IL',
	'IQ',
	'IR',
	'JO',
	'KW',
	'LB',
	'OM',
	'PS',
	'QA',
	'SA',
	'SY',
	'TR',
	'YE',
]);

export const DEFAULT_REGION = 'enam';

export function regionHint(geo: EdgeGeo): string {
	const longitude = Number(geo.longitude ?? NaN);
	switch (geo.continent) {
		case 'NA':
			// The 100th meridian splits the continent's population usefully.
			return Number.isFinite(longitude) && longitude < -100 ? 'wnam' : 'enam';
		case 'SA':
			return 'sam';
		case 'EU':
			// East of ~15°E (Berlin/Vienna) reads better from eeur.
			return Number.isFinite(longitude) && longitude > 15 ? 'eeur' : 'weur';
		case 'AS':
			return geo.country && MIDDLE_EAST.has(geo.country) ? 'me' : 'apac';
		case 'OC':
			return 'oc';
		case 'AF':
			return 'afr';
		default:
			return DEFAULT_REGION;
	}
}

/** The hints a replica name may legally carry (worker-side validation). */
export const REGION_HINTS = new Set([
	'wnam',
	'enam',
	'sam',
	'weur',
	'eeur',
	'apac',
	'apac-ne',
	'apac-se',
	'oc',
	'afr',
	'me',
]);
