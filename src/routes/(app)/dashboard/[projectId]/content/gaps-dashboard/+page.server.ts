import type { PageServerLoad } from './$types';
import * as Sentry from '@sentry/sveltekit';

// Layer-gaps dashboard: mirrors the layers-worker's public GET /gaps — the
// per-city missing-layer matrix recomputed live from the R2 basemaps manifest
// over the bundled 673-city candidate registry. Same access pattern as the
// pmtiles/streetview dashboards: LAYERS service binding first (two Workers on
// the same account cannot fetch() each other by URL — Cloudflare error 1042),
// public URL fallback for local dev.
const LAYERS_GAPS = 'https://layers-worker.foodstarmelbourne.workers.dev/gaps';
const LAYERS_BINDING_URL = 'https://layers-worker/gaps';

interface Gaps {
	ok: boolean;
	generatedAt: string;
	manifestGeneratedAt: string | null;
	manifestFiles: number;
	totals: { candidates: number; withBase: number; noBase: number };
	perLayer: Record<string, number>;
	union: { noBase: string[]; layers: Record<string, string[]> };
	candidates: { slug: string; display: string; hasBase: boolean; missing: string[] }[];
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
			tags: { source: 'gaps-dashboard', upstream: 'layers-worker-binding' }
		});
		res = null;
	}
	if (!res) {
		try {
			res = await fetch(LAYERS_GAPS, { ...init, signal: AbortSignal.timeout(20000) });
		} catch (e) {
			Sentry.captureException(e, {
				tags: { source: 'gaps-dashboard', upstream: 'layers-worker-public' }
			});
			return {
				gaps: null as Gaps | null,
				error: `layers-worker unreachable: ${e instanceof Error ? e.message : String(e)}`
			};
		}
	}
	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		return {
			gaps: null,
			error: `layers-worker /gaps responded ${res.status}: ${detail.slice(0, 200)}`
		};
	}
	const body: unknown = await res.json().catch(() => null);
	if (!body || typeof body !== 'object' || !(body as Record<string, unknown>).ok) {
		return { gaps: null, error: 'layers-worker /gaps returned a malformed payload' };
	}
	return { gaps: body as Gaps, error: null };
};
