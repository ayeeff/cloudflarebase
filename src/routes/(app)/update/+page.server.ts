import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// /update is an alias for the Content Update tab.
export const load: PageServerLoad = () => {
	throw redirect(307, '/dashboard/geo-site/content/update');
};
