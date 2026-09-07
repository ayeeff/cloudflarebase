// src/lib/server/layers-worker.ts
//
// Server-side helper for the Layers Update tab to reach the `layers-worker`
// Worker (the city-atlas layer PMTiles pipeline — buildings/terrain from
// Protomaps + Mapterhorn, satellite from EOX, population from Kontur,
// transit from GTFS, power from OpenInfraMap, bathymetry from GEBCO, all
// written straight into the R2 `globe` bucket the site serves /basemaps/*
// from). Same rationale as update-worker.ts: Cloudflare's edge blocks
// Worker→Worker subrequests on workers.dev, so this rides the direct LAYERS
// service binding, with the public workers.dev URL as a fallback for
// self-hosted installs that have no binding configured.
//
// Auth mirrors the worker itself: when its LAYERS_TOKEN secret is set, every
// route except the intentionally-public GET /dashboard + /gaps demands
// `Authorization: Bearer <token>`; when unset the worker is open. This side
// attaches the header only when our own LAYERS_TOKEN secret/ver is present.

import * as Sentry from '@sentry/sveltekit';

const LAYERS_PUBLIC_BASE = 'https://layers-worker.foodstarmelbourne.workers.dev';
// The service-binding host is arbitrary: both miniflare and the production
// proxy route by the binding name, never by the host.
const LAYERS_BINDING_BASE = 'https://layers-worker';

export interface LayersGapLayer {
	key: string;
	label: string;
	suffix: string;
}

export interface LayersGaps {
	ok: boolean;
	generatedAt?: string;
	manifestGeneratedAt?: string | null;
	manifestFiles?: number;
	totals?: { candidates: number; withBase: number; noBase: number };
	perLayer?: Record<string, number>;
	union?: { noBase: string[]; layers: Record<string, string[]> };
	error?: string;
	unauthorized?: boolean;
}

export interface LayersCityEntry {
	city: string;
	country: string | null;
}

export interface LayersCities {
	ok: boolean;
	siteOrigin?: string;
	bucket?: string;
	prefix?: string;
	layers?: LayersGapLayer[];
	cities?: Record<string, LayersCityEntry>;
	manifestGeneratedAt?: string | null;
	error?: string;
	unauthorized?: boolean;
}

export interface LayersRunStatus {
	ok: boolean;
	id: string;
	status?: string; // queued | running | complete | errored | terminated
	output?: { ok?: boolean; summary?: Record<string, unknown> } | null;
	error?: string;
	unauthorized?: boolean;
}

export interface LayersStart {
	ok: boolean;
	instanceId?: string;
	statusUrl?: string;
	error?: string;
	unauthorized?: boolean;
}

export interface LayersManifestResult {
	ok: boolean;
	count?: number;
	objects?: number;
	durationMs?: number;
	note?: string;
	error?: string;
	unauthorized?: boolean;
}

export interface LayersStateEntry {
	layer: string;
	slug: string;
	status: string;
	tiles?: number;
	bytes?: number;
	note?: string;
	coastal?: boolean;
	error?: string;
	generatedAt?: string;
}

export interface LayersStatesScan {
	ok: boolean;
	totalStates?: number;
	byLayer?: Record<string, { done: number; failed: number; total: number }>;
	failed?: LayersStateEntry[];
	error?: string;
	unauthorized?: boolean;
}

const UNAUTHORIZED_HINT =
	'unauthorized — the layers-worker requires its LAYERS_TOKEN; set the same value as a secret on this Worker: npx wrangler secret put LAYERS_TOKEN';

async function layersWorkerFetch(
	platform: App.Platform | null | undefined,
	path: string,
	init: RequestInit = {}
): Promise<Response | null> {
	const headers = new Headers(init.headers);
	const token = platform?.env?.LAYERS_TOKEN;
	if (token) headers.set('authorization', `Bearer ${token}`);
	const next: RequestInit = { ...init, headers };

	let res: Response | null = null;
	if (platform?.env?.LAYERS) {
		try {
			res = await platform.env.LAYERS.fetch(new Request(new URL(path, LAYERS_BINDING_BASE), next));
		} catch (e) {
			Sentry.captureException(e, { tags: { source: 'layers-worker', upstream: 'binding' } });
		}
	}
	if (!res) {
		try {
			res = await fetch(new URL(path, LAYERS_PUBLIC_BASE), {
				...next,
				signal: AbortSignal.timeout(30000)
			});
		} catch (e) {
			Sentry.captureException(e, { tags: { source: 'layers-worker', upstream: 'public' } });
			return null;
		}
	}
	return res;
}

async function readJson<T extends { ok?: boolean; error?: string }>(
	res: Response | null
): Promise<T | null> {
	if (!res) return null;
	const body = (await res.json().catch(() => null)) as T | null;
	if (!body) return null;
	if (res.status === 401) {
		return {
			...body,
			ok: false,
			error: body.error ?? UNAUTHORIZED_HINT,
			unauthorized: true
		} as T;
	}
	if (!res.ok && body.ok !== false) {
		return {
			...body,
			ok: false,
			error: body.error ?? `layers-worker responded ${res.status}`
		} as T;
	}
	return body;
}

/** Public gap matrix — which cities are missing which layer pmtiles (live manifest). */
export async function getLayersGaps(
	platform: App.Platform | null | undefined
): Promise<LayersGaps> {
	try {
		const body = await readJson<LayersGaps>(await layersWorkerFetch(platform, '/gaps'));
		return body ?? { ok: false, error: 'layers-worker unreachable' };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : 'layers-worker unreachable' };
	}
}

/** Public dashboard payload — city registry + manifest timestamps. */
export async function getLayersCities(
	platform: App.Platform | null | undefined
): Promise<LayersCities> {
	try {
		const body = await readJson<LayersCities>(await layersWorkerFetch(platform, '/dashboard'));
		return body ?? { ok: false, error: 'layers-worker unreachable' };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : 'layers-worker unreachable' };
	}
}

/** Per-workflow-instance status (queued/running/complete/errored + output). */
export async function getLayersRunStatuses(
	platform: App.Platform | null | undefined,
	ids: string[]
): Promise<LayersRunStatus[]> {
	return Promise.all(
		ids.map(async (id): Promise<LayersRunStatus> => {
			try {
				const body = await readJson<LayersRunStatus & { ok: true }>(
					await layersWorkerFetch(platform, `/workflow/status?id=${encodeURIComponent(id)}`)
				);
				return body ?? { ok: false, id, error: 'layers-worker unreachable' };
			} catch (e) {
				return { ok: false, id, error: e instanceof Error ? e.message : 'status fetch failed' };
			}
		})
	);
}

/** Start a CityLayerWorkflow build for (city, layer). */
export async function startLayersRun(
	platform: App.Platform | null | undefined,
	payload: {
		layer: string;
		slug: string;
		bbox: [number, number, number, number];
		city?: string;
		maxFeeds?: number;
	}
): Promise<LayersStart> {
	try {
		const body = await readJson<LayersStart>(
			await layersWorkerFetch(platform, '/workflow/start', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload)
			})
		);
		return body ?? { ok: false, error: 'layers-worker unreachable' };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : 'layers-worker unreachable' };
	}
}

/** Rebuild basemaps/manifest.json from the live R2 listing. */
export async function refreshLayersManifest(
	platform: App.Platform | null | undefined
): Promise<LayersManifestResult> {
	try {
		const body = await readJson<LayersManifestResult>(
			await layersWorkerFetch(platform, '/manifest', { method: 'POST' })
		);
		return body ?? { ok: false, error: 'layers-worker unreachable' };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : 'layers-worker unreachable' };
	}
}

/**
 * Scan every pipeline state json in R2 (GET /status). This is a per-object
 * walk — hundreds of R2 reads in one invocation — so it can exceed the
 * account's subrequest budget; callers treat failure as informational and
 * fall back to /state?layer=&slug= lookups for individual cities.
 */
export async function scanLayerStates(
	platform: App.Platform | null | undefined,
	failedSample = 50
): Promise<LayersStatesScan> {
	try {
		const body = await readJson<{
			ok: boolean;
			byLayer?: Record<string, { done: number; failed: number; total: number }>;
			states?: LayersStateEntry[];
			error?: string;
			unauthorized?: boolean;
		}>(await layersWorkerFetch(platform, '/status'));
		if (!body) return { ok: false, error: 'layers-worker unreachable' };
		if (!body.ok) {
			return {
				ok: false,
				error: body.error ?? 'layers-worker /status failed',
				unauthorized: body.unauthorized
			};
		}
		const states = body.states ?? [];
		return {
			ok: true,
			totalStates: states.length,
			byLayer: body.byLayer ?? {},
			failed: states.filter((s) => s.status === 'failed').slice(0, failedSample)
		};
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : 'layers-worker unreachable' };
	}
}
