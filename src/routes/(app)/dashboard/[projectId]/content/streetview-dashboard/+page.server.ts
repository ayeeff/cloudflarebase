import type { PageServerLoad } from './$types';
import * as Sentry from '@sentry/sveltekit';

// Street-view coverage dashboard (Mapillary + KartaView). Same live source as the
// City Basemaps dashboard: the layers-worker mirrors the R2 basemaps/manifest.json
// plus its baked-in city registry on the intentionally-public GET /dashboard.
//
// In production the fetch goes over the LAYERS service binding (two Workers on the
// same account cannot fetch() each other by URL — Cloudflare error 1042).
const LAYERS_DASHBOARD = 'https://layers-worker.foodstarmelbourne.workers.dev/dashboard';
const LAYERS_BINDING_URL = 'https://layers-worker/dashboard';

// The two street-imagery layers; the worker's LAYERS list must include them
// (workers/layers/src/gaps.js) or the files bucket as `base`.
const STREET_KEYS = ['mapillary', 'kartaview'];

interface Dash {
	ok: boolean;
	siteOrigin: string;
	bucket: string;
	prefix: string;
	layers: { key: string; label: string; suffix: string }[];
	cities: Record<string, { city: string; country: string | null }>;
	manifestGeneratedAt: string | null;
	files: { name: string; size: number; modified?: string }[];
}

export const load: PageServerLoad = async ({ platform }) => {
	let res: Response | null = null;
	const init = { headers: { accept: 'application/json' } };
	try {
		if (platform?.env?.LAYERS) {
			res = await platform.env.LAYERS.fetch(LAYERS_BINDING_URL, init);
		}
	} catch (e) {
		Sentry.captureException(e, {
			tags: { source: 'streetview-dashboard', upstream: 'layers-worker-binding' }
		});
		res = null;
	}
	if (!res) {
		try {
			res = await fetch(LAYERS_DASHBOARD, { ...init, signal: AbortSignal.timeout(15000) });
		} catch (e) {
			Sentry.captureException(e, {
				tags: { source: 'streetview-dashboard', upstream: 'layers-worker-public' }
			});
			return {
				dash: null as Dash | null,
				error: `layers-worker unreachable: ${e instanceof Error ? e.message : String(e)}`
			};
		}
	if (res && res.ok) {
		const body: unknown = await res.json().catch(() => null);
		if (body && typeof body === 'object' && (body as Record<string, unknown>).ok) {
			const d = body as Dash;
			if (d.files && d.files.length > 0) {
				const layers = (d.layers ?? []).filter((l) => STREET_KEYS.includes(l.key));
				return { dash: { ...d, layers }, error: null };
			}
		}
	}

	// Direct GLOBE fallback if bound
	if (platform?.env?.GLOBE) {
		try {
			const manifestObj = (await platform.env.GLOBE.get('data/basemaps-manifest.json')) ||
				(await platform.env.GLOBE.get('basemaps/manifest.json'));
			if (manifestObj) {
				const m = (await manifestObj.json()) as any;
				return {
					dash: {
						ok: true,
						siteOrigin: 'https://geo-astro-site.foodstarmelbourne.workers.dev',
						bucket: 'globe',
						prefix: 'data/',
						layers: [
							{ key: 'mapillary', label: 'Street View (Mapillary)', suffix: 'mapillary' },
							{ key: 'kartaview', label: 'Street View (KartaView)', suffix: 'kartaview' }
						],
						cities: {},
						manifestGeneratedAt: m.generatedAt || null,
						files: m.pmtiles || []
					},
					error: null
				};
			}
		} catch (err) {
			console.warn('[streetview-dashboard] GLOBE direct manifest read failed:', err);
		}
	}

	return {
		dash: null,
		error: res ? `layers-worker /dashboard responded ${res.status}` : 'layers-worker unreachable'
	};
};
