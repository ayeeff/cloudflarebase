// src/lib/server/search-index.ts
//
// Server-side helper for the admin console's Search Index tab
// (/admin/search_index). Talks to geo-astro-site's /api/search-index/* admin
// endpoints over the GEO_ASTRO service binding (same rationale as geo-astro.ts:
// Worker→Worker HTTP on workers.dev is blocked at the edge, the binding is not).

import { geoAstroFetch } from '$lib/server/geo-astro';

export interface SearchIndexStatus {
	running?: boolean;
	runId?: string;
	startedAt?: string | null;
	lastRunAt?: string | null;
	trigger?: 'cron' | 'manual' | null;
	ok?: boolean;
	error?: string | null;
	durationMs?: number | null;
	indexed?: number | null;
	total?: number | null;
	stage?: { type: string; offset: number; total: number | null } | null;
	types?: Record<string, { total: number; indexed: number }>;
	/** Result of the sitemap.xml refresh that runs when the index finishes. */
	sitemap?: { ok: boolean; urls?: number; error?: string; at?: string } | null;
	httpChain?: { type: string; offset: number; error?: string | null } | null;
	schedule?: string;
	neverRun?: boolean;
}

export interface SearchIndexConfig {
	intervalMinutes: number;
	updatedAt?: string | null;
}

export interface SearchDocRow {
	id: string;
	type: string;
	slug: string;
	title: string;
	description: string | null;
	url: string;
	updated_at: number;
}

/** Cadence options for the schedule select — weekly default, floor 5 minutes. */
export const SEARCH_INDEX_INTERVALS: { minutes: number; label: string }[] = [
	{ minutes: 10080, label: 'Weekly' },
	{ minutes: 1440, label: 'Daily' },
	{ minutes: 360, label: 'Every 6 hours' },
	{ minutes: 60, label: 'Hourly' },
	{ minutes: 15, label: 'Every 15 minutes' },
	{ minutes: 5, label: 'Every 5 minutes' }
];

export async function getSearchIndexOverview(
	platform: App.Platform | null | undefined
): Promise<{ status: SearchIndexStatus | null; config: SearchIndexConfig | null; error?: string }> {
	try {
		const res = await geoAstroFetch(platform, '/api/search-index/status');
		if (!res.ok) {
			return { status: null, config: null, error: `geo-astro-site responded ${res.status}` };
		}
		const body = (await res.json()) as {
			ok: boolean;
			status: SearchIndexStatus;
			config: SearchIndexConfig;
		};
		return { status: body.status, config: body.config };
	} catch (e) {
		return {
			status: null,
			config: null,
			error: e instanceof Error ? e.message : 'geo-astro-site unreachable'
		};
	}
}

/** Enqueue a full search-index rebuild ("run now"). */
export async function triggerSearchIndexRun(
	platform: App.Platform | null | undefined
): Promise<{ ok: boolean; runId?: string; reason?: string; error?: string }> {
	try {
		const res = await geoAstroFetch(platform, '/api/search-index/run', { method: 'POST' });
		return (await res.json().catch(() => ({}))) as {
			ok: boolean;
			runId?: string;
			reason?: string;
			error?: string;
		};
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : 'geo-astro-site unreachable' };
	}
}

/** Set the update cadence (minutes). */
export async function setSearchIndexInterval(
	platform: App.Platform | null | undefined,
	minutes: number
): Promise<{ ok: boolean; config?: SearchIndexConfig; error?: string }> {
	try {
		const res = await geoAstroFetch(platform, '/api/search-index/config', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ intervalMinutes: minutes })
		});
		return (await res.json().catch(() => ({}))) as {
			ok: boolean;
			config?: SearchIndexConfig;
			error?: string;
		};
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : 'geo-astro-site unreachable' };
	}
}

/** Paginated listing of the indexed documents (straight from search_docs). */
export async function listSearchIndexDocs(
	platform: App.Platform | null | undefined,
	opts: { q?: string; type?: string; offset?: number; limit?: number } = {}
): Promise<{
	ok: boolean;
	total: number;
	offset: number;
	limit: number;
	docs: SearchDocRow[];
	error?: string;
}> {
	const params = new URLSearchParams();
	if (opts.q) params.set('q', opts.q);
	if (opts.type) params.set('type', opts.type);
	params.set('offset', String(opts.offset ?? 0));
	params.set('limit', String(opts.limit ?? 25));
	try {
		const res = await geoAstroFetch(platform, `/api/search-index/docs?${params.toString()}`);
		if (!res.ok) {
			return {
				ok: false,
				total: 0,
				offset: opts.offset ?? 0,
				limit: opts.limit ?? 25,
				docs: [],
				error: `geo-astro-site responded ${res.status}`
			};
		}
		return (await res.json()) as {
			ok: boolean;
			total: number;
			offset: number;
			limit: number;
			docs: SearchDocRow[];
			error?: string;
		};
	} catch (e) {
		return {
			ok: false,
			total: 0,
			offset: opts.offset ?? 0,
			limit: opts.limit ?? 25,
			docs: [],
			error: e instanceof Error ? e.message : 'geo-astro-site unreachable'
		};
	}
}
