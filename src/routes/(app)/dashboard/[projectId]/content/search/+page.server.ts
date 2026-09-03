import {
	getSearchIndexOverview,
	listSearchIndexDocs,
	setSearchIndexInterval,
	triggerSearchIndexRun
} from '$lib/server/search-index';
import type { PageServerLoad, Actions } from './$types';

// Mirror of /admin/search_index inside the geo-site dashboard's Content
// section: status of the site search index (search_docs + Vectorize on
// geo-astro-site) — when it was last updated, the update cadence (weekly
// default, tunable down to every 5 minutes), a run-now button, and a
// paginated listing of the indexed documents. Auth comes from the content
// layout's ADMIN_SECRET gate, same as every other /content/* tool page; the
// upstream calls ride the GEO_ASTRO service binding with the shared secret.

export const load: PageServerLoad = async ({ platform, url }) => {
	const q = url.searchParams.get('q') ?? '';
	const type = url.searchParams.get('type') ?? '';
	const offset = parseInt(url.searchParams.get('offset') ?? '0', 10) || 0;

	const [overview, docs] = await Promise.all([
		getSearchIndexOverview(platform),
		listSearchIndexDocs(platform, { q, type, offset, limit: 25 })
	]);

	return { overview, docs, q, type, offset };
};

export const actions: Actions = {
	// "Run the update now" — enqueues a full rebuild on geo-astro-site (the
	// heavy work runs queue-chained over there; this returns immediately).
	run: async ({ platform }) => {
		const res = await triggerSearchIndexRun(platform);
		if (!res.ok) {
			const reason =
				res.reason === 'already-running'
					? 'An update is already running.'
					: (res.error ?? res.reason ?? 'Could not start the update.');
			return { success: false as const, error: reason };
		}
		return { success: true as const, runId: res.runId };
	},

	// Schedule select — persist the cadence (minutes) on geo-astro-site.
	interval: async ({ request, platform }) => {
		const form = await request.formData();
		const minutes = parseInt(String(form.get('intervalMinutes') ?? ''), 10);
		if (!Number.isFinite(minutes) || minutes < 5) {
			return { success: false as const, error: 'Pick a valid interval (minimum 5 minutes).' };
		}
		const res = await setSearchIndexInterval(platform, minutes);
		if (!res.ok) {
			return { success: false as const, error: res.error ?? 'Could not save the interval.' };
		}
		return { success: true as const, intervalMinutes: res.config?.intervalMinutes ?? minutes };
	}
};
