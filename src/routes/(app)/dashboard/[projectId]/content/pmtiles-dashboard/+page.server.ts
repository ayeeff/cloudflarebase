import type { PageServerLoad } from './$types';

// The pmtiles dashboard is a live view of the city-basemaps R2 bucket. The
// layers-worker mirrors the R2 basemaps/manifest.json plus its baked-in city
// registry on the intentionally-public GET /dashboard endpoint (all the data
// it serves — file names/sizes and city slugs — is already public because the
// pmtiles themselves are served from the site).
const LAYERS_DASHBOARD = 'https://layers-worker.foodstarmelbourne.workers.dev/dashboard';

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

export const load: PageServerLoad = async () => {
	let res: Response;
	try {
		res = await fetch(LAYERS_DASHBOARD, {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(15000)
		});
	} catch (e) {
		return {
			dash: null as Dash | null,
			error: `layers-worker unreachable: ${e instanceof Error ? e.message : String(e)}`
		};
	}
	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		return {
			dash: null,
			error: `layers-worker /dashboard responded ${res.status}: ${detail.slice(0, 200)}`
		};
	}
	const body: unknown = await res.json().catch(() => null);
	if (!body || typeof body !== 'object' || !(body as Record<string, unknown>).ok) {
		return { dash: null, error: 'layers-worker /dashboard returned a malformed payload' };
	}
	return { dash: body as Dash, error: null };
};
