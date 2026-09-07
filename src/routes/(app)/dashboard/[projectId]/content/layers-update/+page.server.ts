import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	getLayersCities,
	getLayersGaps,
	getLayersRunStatuses,
	refreshLayersManifest,
	scanLayerStates,
	startLayersRun
} from '$lib/server/layers-worker';
import * as Sentry from '@sentry/sveltekit';

// Mirror of the Atlas Update tab for the layers-worker city-layer pipeline:
// live gap matrix (which cities miss which pmtiles), start/track of
// CityLayerWorkflow runs, a basemaps-manifest refresh, and an on-demand
// pipeline-state scan — all served by the layers-worker over the LAYERS
// service binding. Auth comes from the content layout's ADMIN_SECRET gate,
// same as every other /content/* tool page; the worker's own routes are
// bearer-gated by its LAYERS_TOKEN secret (dashboard + gaps stay public).

// The city registry the worker bundles (GET /dashboard) — used for the slug
// autocomplete and as the Nominatim query when no bbox is pasted.
const MAX_TRACKED_RUNS = 12;
const WORKFLOW_LAYERS = [
	'buildings',
	'terrain',
	'satellite',
	'population',
	'transit',
	'power',
	'bathymetry'
] as const;

function parseRunIds(raw: string | null): string[] {
	return (raw ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter((s) => /^[\w-]{1,80}$/.test(s))
		.slice(0, MAX_TRACKED_RUNS);
}

export const load: PageServerLoad = async ({ platform, url }) => {
	const [gaps, cities] = await Promise.all([getLayersGaps(platform), getLayersCities(platform)]);
	const runIds = parseRunIds(url.searchParams.get('run'));
	const runs = runIds.length ? await getLayersRunStatuses(platform, runIds) : [];
	return { gaps, cities, runs, runIds };
};

export const actions: Actions = {
	/** Start a CityLayerWorkflow build for one (city, layer). */
	start: async ({ request, platform, url }) => {
		const form = await request.formData();
		const layer = String(form.get('layer') ?? '').trim();
		const slug = String(form.get('slug') ?? '')
			.trim()
			.toLowerCase();
		const city = String(form.get('city') ?? '').trim();
		const rawBbox = String(form.get('bbox') ?? '').trim();
		const rawMaxFeeds = String(form.get('maxFeeds') ?? '').trim();

		if (!(WORKFLOW_LAYERS as readonly string[]).includes(layer)) {
			return fail(400, {
				action: 'start',
				error: `layer must be one of: ${WORKFLOW_LAYERS.join(', ')}`
			});
		}
		if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
			return fail(400, {
				action: 'start',
				error: 'slug is required — lowercase city slug, e.g. paris'
			});
		}

		let bbox: [number, number, number, number] | null;
		if (rawBbox) {
			const parts = rawBbox.split(',').map((s) => Number(s.trim()));
			if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
				return fail(400, {
					action: 'start',
					error: 'bbox must be 4 comma-separated numbers — minLng,minLat,maxLng,maxLat'
				});
			}
			bbox = [parts[0], parts[1], parts[2], parts[3]];
		} else {
			// No bbox pasted — geocode the city via Nominatim, the same fallback
			// the batch driver (layer/run-store-city-basemaps.mjs) uses.
			try {
				bbox = await geocodeBbox(city || slug);
			} catch (e) {
				Sentry.captureException(e, { tags: { source: 'layers-update', op: 'geocode' } });
				return fail(502, {
					action: 'start',
					error: `bbox geocode failed: ${e instanceof Error ? e.message : String(e)} — paste one as minLng,minLat,maxLng,maxLat`
				});
			}
			if (!bbox) {
				return fail(400, {
					action: 'start',
					error: `could not geocode a bbox for "${city || slug}" — paste one as minLng,minLat,maxLng,maxLat`
				});
			}
		}

		const started = await startLayersRun(platform, {
			layer,
			slug,
			bbox,
			city: city || undefined,
			maxFeeds:
				rawMaxFeeds && Number.isFinite(Number(rawMaxFeeds)) ? Number(rawMaxFeeds) : undefined
		});
		if (!started.ok || !started.instanceId) {
			return fail(502, {
				action: 'start',
				error: started.unauthorized
					? UNAUTHORIZED_MSG
					: (started.error ?? 'layers-worker did not start the run')
			});
		}

		const ids = [
			...new Set([...parseRunIds(url.searchParams.get('run')), started.instanceId])
		].slice(-MAX_TRACKED_RUNS);
		redirect(303, `./?run=${ids.join(',')}`);
	},

	/** Track an existing workflow instance id (e.g. after reopening the console). */
	track: async ({ request, url }) => {
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!/^[\w-]{1,80}$/.test(id)) {
			return fail(400, {
				action: 'track',
				error: 'that does not look like a workflow instance id'
			});
		}
		const ids = [...new Set([...parseRunIds(url.searchParams.get('run')), id])].slice(
			-MAX_TRACKED_RUNS
		);
		redirect(303, `./?run=${ids.join(',')}`);
	},

	/** Rebuild basemaps/manifest.json from the live R2 listing. */
	manifest: async ({ platform }) => {
		const result = await refreshLayersManifest(platform);
		if (!result.ok) {
			return fail(502, {
				action: 'manifest',
				error: result.unauthorized ? UNAUTHORIZED_MSG : (result.error ?? 'manifest refresh failed')
			});
		}
		return { action: 'manifest', manifest: result };
	},

	/** On-demand walk of every pipeline state json (per-layer done/failed counts). */
	states: async ({ platform }) => {
		const result = await scanLayerStates(platform);
		if (!result.ok) {
			return fail(502, {
				action: 'states',
				error: result.unauthorized ? UNAUTHORIZED_MSG : (result.error ?? 'state scan failed')
			});
		}
		return { action: 'states', states: result };
	}
};

const UNAUTHORIZED_MSG =
	'layers-worker rejected the call (401 unauthorized) — it runs with a LAYERS_TOKEN, so this Worker needs the same value: npx wrangler secret put LAYERS_TOKEN';

// Nominatim geocode — [south, north, west, east] on the wire → [minLng, minLat, maxLng, maxLat].
async function geocodeBbox(query: string): Promise<[number, number, number, number] | null> {
	const res = await fetch(
		`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`,
		{
			headers: { 'User-Agent': 'cloudflarebase layers-update (city layer builds)' },
			signal: AbortSignal.timeout(30000)
		}
	);
	if (!res.ok) throw new Error(`nominatim responded ${res.status}`);
	const hits = (await res.json()) as { boundingbox?: string[] }[];
	if (!Array.isArray(hits) || !hits.length || !hits[0].boundingbox) return null;
	const bb = hits[0].boundingbox.map(Number); // [south, north, west, east]
	await new Promise((r) => setTimeout(r, 1100)); // Nominatim politeness (1 req/s)
	return [bb[2], bb[0], bb[3], bb[1]];
}
