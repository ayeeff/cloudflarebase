import { redirect } from '@sveltejs/kit';
import { buildContentActions } from '$lib/server/admin-content';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = () => {
	throw redirect(307, '/dashboard/geo-site/content/write');
};
export const actions: Actions = buildContentActions('write');
