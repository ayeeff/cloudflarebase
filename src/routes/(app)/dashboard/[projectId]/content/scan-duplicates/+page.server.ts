import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	deleteDuplicateKeys,
	getScanReport,
	triggerScan
} from '$lib/server/scan-duplicates';

// Mirror of a geo-site maintenance tool: the scan-duplicates Worker walks
// (1) src/pages .astro for content clones + basename route risk,
// (2) globe/basemaps for etag byte-dups + name-normalized collisions,
// (3) geo-datalake sources/ for etag + basename dups,
// (4) layer-harness __caCfg / .vtab duplicate keys (batched via cursor).
// Auth comes from the content layout's ADMIN_SECRET gate; upstream calls ride
// the SCAN service binding (public-URL fallback when the binding is absent).

const HARNESS_MAX_BATCHES = 40;

export const load: PageServerLoad = async ({ platform }) => {
	const report = await getScanReport(platform);
	return { report: report.report ?? null, reportError: report.ok ? null : report.error };
};

export const actions: Actions = {
	/** Manual "Scan now" — full pass (pages + basemaps + datalake + first harness batch). */
	scan: async ({ platform }) => {
		const result = await triggerScan(platform, { phase: 'full' });
		if (!result.ok) return fail(502, { action: 'scan', error: result.error ?? 'Scan failed.' });
		return { success: true as const, action: 'scan', report: result.report };
	},

	/**
	 * Continue the harness cursor until done (or HARNESS_MAX_BATCHES). The
	 * Worker batches ~180 raw fetches per call to stay inside the subrequest
	 * budget; this action loops server-side so one button press finishes.
	 */
	scanHarness: async ({ platform }) => {
		let last = await triggerScan(platform, { phase: 'harness' });
		if (!last.ok) return fail(502, { action: 'scanHarness', error: last.error ?? 'Harness scan failed.' });
		let batches = 1;
		while (last.report?.harness && !last.report.harness.done && batches < HARNESS_MAX_BATCHES) {
			const cursor = last.report.harness.cursor;
			if (!cursor) break;
			last = await triggerScan(platform, { phase: 'harness', cursor });
			if (!last.ok) {
				return fail(502, {
					action: 'scanHarness',
					error: `${last.error ?? 'Harness batch failed.'} (after ${batches} batches)`,
					report: last.report
				});
			}
			batches++;
		}
		return {
			success: true as const,
			action: 'scanHarness',
			report: last.report,
			batches,
			done: last.report?.harness?.done ?? false
		};
	},

	/** Delete selected R2 keys — Worker refuses unless each shares an etag with a survivor. */
	deleteKeys: async ({ request, platform }) => {
		const form = await request.formData();
		const bucket = form.get('bucket') === 'geo-datalake' ? 'geo-datalake' : 'globe';
		let keys: string[] = [];
		try {
			const parsed = JSON.parse(String(form.get('keys') ?? '[]'));
			if (Array.isArray(parsed)) keys = parsed.filter((k) => typeof k === 'string');
		} catch {
			/* fall through to error below */
		}
		if (!keys.length) return fail(400, { action: 'deleteKeys', error: 'No keys selected.' });
		const result = await deleteDuplicateKeys(platform, { bucket: bucket as 'globe' | 'geo-datalake', keys });
		if (!result.ok) {
			return fail(400, {
				action: 'deleteKeys',
				error: result.error ?? 'Delete failed.',
				unsafe: result.unsafe
			});
		}
		// Re-read the report so the UI reflects removals immediately.
		const report = await getScanReport(platform);
		return {
			success: true as const,
			action: 'deleteKeys',
			deletedCount: result.deletedCount ?? 0,
			report: report.report ?? null
		};
	}
};
