// src/lib/server/update-worker.ts
//
// Server-side helper for the admin console's Update tab to reach the `update`
// Worker (the weekly cron that refreshes World Bank data for
// /maps/global-population and /maps/global-gdp). Same rationale as
// geo-astro.ts: Cloudflare's edge blocks Worker→Worker subrequests on
// workers.dev, so this rides the direct UPDATE_WORKER service binding.

export interface UpdateStatus {
	ok: boolean;
	lastRunAt?: string;
	trigger?: 'cron' | 'manual';
	error?: string;
	durationMs?: number;
	schedule?: string;
	neverRun?: boolean;
	maps?: Record<string, { countries: number; years: string; indicator: string }>;
}

export async function updateWorkerFetch(
	platform: App.Platform | null | undefined,
	path: string,
	init: RequestInit = {}
): Promise<Response> {
	const binding = platform?.env?.UPDATE_WORKER;
	if (!binding) {
		throw new Error('UPDATE_WORKER service binding is not configured on this deployment.');
	}
	const url = new URL(path, 'https://update-worker');
	return binding.fetch(new Request(url, init));
}

export async function getUpdateStatus(
	platform: App.Platform | null | undefined
): Promise<UpdateStatus> {
	try {
		const res = await updateWorkerFetch(platform, '/status');
		return (await res.json()) as UpdateStatus;
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : 'update worker unreachable' };
	}
}

export async function triggerUpdateRun(
	platform: App.Platform | null | undefined
): Promise<UpdateStatus & { ranAt?: string }> {
	try {
		const res = await updateWorkerFetch(platform, '/run', { method: 'POST' });
		const body = (await res.json().catch(() => ({}))) as { status?: UpdateStatus; error?: string };
		if (!res.ok && !body?.status) {
			return { ok: false, error: body?.error ?? `update worker responded ${res.status}` };
		}
		// /run answers with the run summary plus the status doc it just wrote.
		return (body.status ?? body) as UpdateStatus;
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : 'update worker unreachable' };
	}
}

// ── Monthly atlas refresh (update Worker /atlas/* endpoints) ─────────────────

export interface AtlasProgress {
	runId: string;
	startedAt: string;
	trigger?: 'cron' | 'manual';
	dry?: boolean;
	phase: 'refresh' | 'images' | 'done';
	cities?: string[];
	cityIndex?: number;
	pages?: string[];
	pageIndex?: number;
	citiesDone?: number;
	totals?: Record<string, number>;
	families?: Record<string, Record<string, number>>;
	overtureCities?: number;
	errors?: string[];
	lastBatchAt?: string;
}

export interface AtlasStatus {
	ok: boolean;
	feature?: string;
	schedule?: string;
	neverRun?: boolean;
	status?: {
		lastRunAt?: string;
		trigger?: 'cron' | 'manual';
		ok?: boolean;
		error?: string;
		durationMs?: number;
		dry?: boolean;
		totals?: Record<string, number>;
		families?: Record<string, Record<string, number>>;
		overtureCities?: number;
	} | null;
	progress?: AtlasProgress | null;
	registry?: { count: number; cities: number; generatedAt?: string } | null;
	overture?: { stagedAt?: string; cities?: number; failed?: number } | null;
	error?: string;
}

export async function getAtlasStatus(
	platform: App.Platform | null | undefined
): Promise<AtlasStatus> {
	try {
		const res = await updateWorkerFetch(platform, '/atlas/status');
		return (await res.json()) as AtlasStatus;
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : 'update worker unreachable' };
	}
}

export async function triggerAtlasRun(
	platform: App.Platform | null | undefined,
	dry = false
): Promise<{ ok: boolean; runId?: string; dry?: boolean; error?: string; progress?: AtlasProgress }> {
	try {
		const res = await updateWorkerFetch(platform, `/atlas/run${dry ? '?dry=1' : ''}`, { method: 'POST' });
		const body = (await res.json().catch(() => ({}))) as {
			ok?: boolean;
			runId?: string;
			dry?: boolean;
			error?: string;
			progress?: AtlasProgress;
		};
		return {
			ok: res.ok && body?.ok !== false,
			runId: body?.runId,
			dry: body?.dry,
			error: body?.error ?? (res.ok ? undefined : `update worker responded ${res.status}`),
			progress: body?.progress
		};
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : 'update worker unreachable' };
	}
}
