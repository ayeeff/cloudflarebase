import { getUpdateStatus, triggerUpdateRun } from '$lib/server/update-worker';
import type { PageServerLoad, Actions } from './$types';

// The /admin/update tab: last run of the `update` Worker (weekly World Bank
// refresh for /maps/global-population + /maps/global-gdp) and a manual /run
// button. Auth is inherited from the (app)/admin layout's cfb-admin-session
// cookie gate.

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
