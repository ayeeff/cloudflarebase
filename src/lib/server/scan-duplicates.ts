// src/lib/server/scan-duplicates.ts
//
// Server-side helper for the admin console's Scan Duplicates tab
// (/dashboard/geo-site/content/scan-duplicates). Talks to the dedicated
// scan-duplicates Worker over the SCAN service binding (same rationale as
// geo-astro.ts / layers-worker.ts: Worker→Worker HTTP on workers.dev is
// edge-blocked; the binding is not).

const SCAN_BINDING_BASE = 'https://scan-duplicates';
const SCAN_PUBLIC_BASE = 'https://scan-duplicates.foodstarmelbourne.workers.dev';

export interface ScanDupGroup {
	etag?: string;
	sha?: string;
	size?: number;
	keys?: string[];
	paths?: string[];
	base?: string;
	basename?: string;
	city?: string;
	layer?: string;
	sizes?: number[];
	etags?: string[];
}

export interface ScanPagesSection {
	ok?: boolean;
	branch?: string;
	files?: number;
	truncated?: boolean;
	identicalContent?: ScanDupGroup[];
	identicalContentCount?: number;
	routeRisk?: ScanDupGroup[];
	routeRiskCount?: number;
	durationMs?: number;
	error?: string;
}

export interface ScanBasemapsSection {
	ok?: boolean;
	files?: number;
	identicalContent?: ScanDupGroup[];
	identicalContentCount?: number;
	nameCollisions?: ScanDupGroup[];
	nameCollisionsCount?: number;
	durationMs?: number;
	error?: string;
}

export interface ScanDatalakeSection {
	ok?: boolean;
	files?: number;
	identicalContent?: ScanDupGroup[];
	identicalContentCount?: number;
	sameBasename?: ScanDupGroup[];
	sameBasenameCount?: number;
	durationMs?: number;
	error?: string;
}

export interface ScanHarnessDup {
	key?: string;
	view?: string;
	count: number;
}

export interface ScanHarnessFile {
	path: string;
	dups: ScanHarnessDup[];
}

export interface ScanHarnessSection {
	ok?: boolean;
	branch?: string;
	cursor?: string | null;
	done?: boolean;
	totalCandidates?: number;
	scanned?: number;
	errors?: number;
	cacfgDupFiles?: ScanHarnessFile[];
	cacfgDupCount?: number;
	vtabDupFiles?: ScanHarnessFile[];
	vtabDupCount?: number;
	durationMs?: number;
	generatedAt?: string;
	error?: string;
}

export interface ScanReport {
	generatedAt?: string | null;
	updatedAt?: string;
	branch?: string;
	pages?: ScanPagesSection | null;
	basemaps?: ScanBasemapsSection | null;
	datalake?: ScanDatalakeSection | null;
	harness?: ScanHarnessSection | null;
}

export interface ScanDeleteResult {
	ok: boolean;
	deleted?: string[];
	deletedCount?: number;
	failed?: { key: string; error: string }[];
	error?: string;
	unsafe?: string[];
}

async function scanFetch(
	platform: App.Platform | null | undefined,
	path: string,
	init: RequestInit = {}
): Promise<Response> {
	const binding = platform?.env?.SCAN;
	const headers = new Headers(init.headers);
	const token = platform?.env?.SCAN_TOKEN;
	if (token && !headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);

	if (binding) {
		const url = new URL(path, SCAN_BINDING_BASE);
		return binding.fetch(new Request(url, { ...init, headers }));
	}
	// Public-URL fallback for installs without the service binding configured.
	const url = new URL(path, SCAN_PUBLIC_BASE);
	return fetch(url, { ...init, headers, signal: AbortSignal.timeout(60_000) });
}

/** Last persisted report (R2 scan-duplicates/report.json), or null if none yet. */
export async function getScanReport(
	platform: App.Platform | null | undefined
): Promise<{ ok: boolean; report?: ScanReport; error?: string }> {
	try {
		const res = await scanFetch(platform, '/report');
		if (res.status === 404) return { ok: false, error: 'No report yet — run a scan.' };
		if (!res.ok) return { ok: false, error: `scan-duplicates responded ${res.status}` };
		const body = (await res.json()) as { ok: boolean; report?: ScanReport; error?: string };
		return body;
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : 'scan-duplicates unreachable' };
	}
}

/**
 * Trigger a scan. `phase: 'full'` (default) runs pages+basemaps+datalake and
 * the first harness batch; `phase: 'harness'` continues the harness cursor
 * until `report.harness.done`.
 */
export async function triggerScan(
	platform: App.Platform | null | undefined,
	opts: { branch?: 'preview' | 'master'; targets?: string[]; phase?: 'full' | 'harness'; cursor?: string } = {}
): Promise<{ ok: boolean; report?: ScanReport; phase?: string; error?: string }> {
	try {
		const res = await scanFetch(platform, '/scan', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(opts)
		});
		const body = (await res.json().catch(() => ({}))) as {
			ok: boolean;
			report?: ScanReport;
			phase?: string;
			error?: string;
		};
		if (!res.ok && !body.error) return { ok: false, error: `scan-duplicates responded ${res.status}` };
		return body;
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : 'scan-duplicates unreachable' };
	}
}

/** Delete confirmed etag-duplicate R2 keys (never .astro — report-only there). */
export async function deleteDuplicateKeys(
	platform: App.Platform | null | undefined,
	opts: { bucket: 'globe' | 'geo-datalake'; keys: string[] }
): Promise<ScanDeleteResult> {
	try {
		const res = await scanFetch(platform, '/delete', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(opts)
		});
		const body = (await res.json().catch(() => ({}))) as ScanDeleteResult;
		if (!res.ok && !body.error) return { ok: false, error: `scan-duplicates responded ${res.status}` };
		return body;
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : 'scan-duplicates unreachable' };
	}
}
