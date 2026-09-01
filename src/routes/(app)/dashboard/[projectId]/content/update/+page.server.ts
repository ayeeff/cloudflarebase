import { getUpdateStatus, triggerUpdateRun } from '$lib/server/update-worker';
import type { PageServerLoad, Actions } from './$types';

// Mirror of /admin/update inside the geo-site dashboard's Content section.
// Same update-Worker status + manual /run; auth comes from the content
// layout's ADMIN_SECRET gate, same as every other /content/* tool page.

export const load: PageServerLoad = async ({ platform }) => {
	const status = await getUpdateStatus(platform);
	return { status, cron: 'Mondays 03:00 UTC (0 3 * * MON)' };
};

export const actions: Actions = {
	run: async ({ platform }) => {
		const status = await triggerUpdateRun(platform);
		if (!status.ok) {
			return { success: false as const, error: status.error ?? 'Update run failed.', status };
		}
		return { success: true as const, status };
	}
};
