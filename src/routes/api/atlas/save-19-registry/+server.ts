import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	loadAtlas19StorageReport,
	save19RegistryToR2
} from '$lib/server/atlas-19-files-storage';
import seedRegistry from '$lib/data/atlas-2d-missing-files.json';

/**
 * POST /api/atlas/save-19-registry
 *
 * Runs the full paginated R2 scan and writes the result to
 * registry/atlas-19-files-registry.json in the globe bucket.
 *
 * Auth: x-admin-key header must equal the ADMIN_SECRET env var.
 *
 * curl example:
 *   curl -s -X POST https://cloudflarebase.foodstarmelbourne.workers.dev/api/atlas/save-19-registry \
 *        -H "x-admin-key: <ADMIN_SECRET>"
 */
export const POST: RequestHandler = async ({ request, platform }) => {
	// --- auth ---
	const secret = platform?.env?.ADMIN_SECRET;
	if (!secret) {
		return json({ ok: false, error: 'ADMIN_SECRET not configured' }, { status: 503 });
	}
	const provided = request.headers.get('x-admin-key') ?? '';
	if (provided !== secret) {
		return json({ ok: false, error: 'Unauthorized' }, { status: 401 });
	}

	// --- build city list from seed ---
	const rawCities = (seedRegistry as any).cities ?? [];
	const citySlugs: string[] = Array.isArray(rawCities)
		? rawCities.map((c: any) => String(c.slug ?? '').replace(/-city-atlas$/, '')).filter(Boolean)
		: [];

	// --- paginated scan + save ---
	const report = await loadAtlas19StorageReport(platform, citySlugs);
	const saved = await save19RegistryToR2(platform, report);

	return json({
		ok: saved,
		source: report.source,
		generatedAt: report.generatedAt,
		totalCities: report.totals.totalCities,
		citiesComplete: report.totals.citiesCompleteBoth,
		citiesWithMissing: report.totals.citiesWithAnyMissing
	});
};
