import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { loadAtlas2DStorageReport } from '$lib/server/atlas-2d-storage';
import { geoAstroFetch } from '$lib/server/geo-astro';

export const GET: RequestHandler = async ({ platform, url }) => {
	// Retrieve all cities from collections or seed
	let citySlugs: string[] = [];
	try {
		const res = await geoAstroFetch(platform, '/data/atlas-collections.json');
		if (res.ok) {
			const coll = (await res.json()) as any;
			const cityEntries = coll?.City ?? [];
			citySlugs = cityEntries.map((c: any) => String(c.slug ?? '').replace(/-city-atlas$/i, ''));
		}
	} catch {
		// fall through
	}

	const report = await loadAtlas2DStorageReport(platform, citySlugs);
	const data = JSON.parse(report.missingRegistryJson);

	const isDownload = url.searchParams.get('download') === '1';
	const headers: Record<string, string> = {
		'content-type': 'application/json; charset=utf-8'
	};
	if (isDownload) {
		headers['content-disposition'] = 'attachment; filename="missing-atlas-2d-files.json"';
	}

	return new Response(JSON.stringify(data, null, 2), {
		status: 200,
		headers
	});
};
