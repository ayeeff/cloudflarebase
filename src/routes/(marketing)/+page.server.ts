import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * The landing page is cloudflarebase.com's marketing surface, which only the
 * public demo deployment has an audience for. On a private install (DEMO_MODE
 * unset) the deployment IS the product, so the root hands its operator
 * straight to the console - and the guard bounces to /login when there is no
 * session yet.
 */
export const load: PageServerLoad = ({ locals }) => {
	if (!locals.demoMode) {
		redirect(307, '/dashboard');
	}
};
