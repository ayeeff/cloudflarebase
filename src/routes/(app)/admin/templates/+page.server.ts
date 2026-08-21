import { serverError } from '$lib/server/agents';
import type { PageServerLoad } from './$types';

const GEO_ASTRO_BASE = 'https://geo-astro-site.foodstarmelbourne.workers.dev';

export const load: PageServerLoad = async ({ fetch, platform }) => {
	const adminKey = platform?.env?.ADMIN_SECRET;
	const response = await fetch(`${GEO_ASTRO_BASE}/api/addtemplate`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...(adminKey ? { 'x-admin-key': adminKey } : {}) },
		body: JSON.stringify({ action: 'get-categories' })
	});
	if (!response.ok) serverError(502, `geo-astro-site /api/addtemplate responded ${response.status}`);
	const data = await response.json();
	return { categories: data.categories ?? [], count: data.count ?? 0 };
};
