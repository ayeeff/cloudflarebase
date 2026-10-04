import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { loadAtlas2DStorageReport } from '$lib/server/atlas-2d-storage';
import { geoAstroFetch } from '$lib/server/geo-astro';

import seedRegistry from '$lib/data/atlas-2d-missing-files.json';

export const GET: RequestHandler = async ({ platform, url }) => {
	// Retrieve all cities from collections or seed
	const slugSet = new Set<string>();
	try {
		const res = await geoAstroFetch(platform, '/data/atlas-collections.json');
		if (res.ok) {
			const coll = (await res.json()) as any;
			const cityEntries = coll?.City ?? [];
			for (const c of cityEntries) {
				const s = String(c.slug ?? '').replace(/-city-atlas$/i, '').trim();
				if (s) slugSet.add(s);
			}
		}
	} catch {
		// fall through
	}

	if (Array.isArray((seedRegistry as any).cities)) {
		for (const sc of (seedRegistry as any).cities) {
			if (sc.slug) slugSet.add(sc.slug);
		}
	}

	const citySlugs = [...slugSet];
	const report = await loadAtlas2DStorageReport(platform, citySlugs);
	const data = JSON.parse(report.missingRegistryJson);

	const isDownload = url.searchParams.get('download') === '1';
	const headers: Record<string, string> = {
		'content-type': 'application/json; charset=utf-8',
		'access-control-allow-origin': '*',
		'cache-control': 'public, max-age=60'
	};
	if (isDownload) {
		headers['content-disposition'] = 'attachment; filename="missing-atlas-2d-files.json"';
	}

	return new Response(JSON.stringify(data, null, 2), {
		status: 200,
		headers
	});
};
