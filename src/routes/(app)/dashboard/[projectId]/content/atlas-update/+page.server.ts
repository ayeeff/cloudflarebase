import { getAtlasStatus, triggerAtlasRun } from '$lib/server/update-worker';
import type { PageServerLoad, Actions } from './$types';

// Mirror of the Update tab for the monthly atlas POI refresh: last-run status
// + in-flight progress + manual run / dry-run, all served by the `update`
// Worker (update.foodstarmelbourne.workers.dev) over the UPDATE_WORKER
// service binding. Auth comes from the content layout's ADMIN_SECRET gate,
// same as every other /content/* tool page.

export const load: PageServerLoad = async ({ platform }) => {
	const status = await getAtlasStatus(platform);
	return { status, cron: '1st of the month 04:00 UTC (0 4 1 * *)' };
};

export const actions: Actions = {
	run: async ({ platform }) => {
		const started = await triggerAtlasRun(platform, false);
		if (!started.ok) {
			return { success: false as const, error: started.error ?? 'Atlas run failed to start.', started };
		}
		return { success: true as const, started };
	},
	dry: async ({ platform }) => {
		const started = await triggerAtlasRun(platform, true);
		if (!started.ok) {
			return { success: false as const, error: started.error ?? 'Atlas dry run failed to start.', started };
		}
		return { success: true as const, started };
	}
};
