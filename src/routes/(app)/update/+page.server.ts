import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// /update is an alias for the admin console's Update tab. The real page lives
// under /admin so it inherits the cfb-admin-session cookie gate.
export const load: PageServerLoad = () => {
	throw redirect(307, '/admin/update');
};
