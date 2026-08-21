import { redirect } from '@sveltejs/kit';
import { sha256Hex, COOKIE } from '$lib/server/admin-session';
import type { LayoutServerLoad } from './$types';

// ADMIN_SECRET gate for the content-management tools mounted under the
// dashboard. These pages live inside the dashboard shell (so they appear in
// the left panel) but are gated by the shared admin password, not by dashboard
// project membership. Unauthenticated requests bounce to /admin/login, which
// returns here via ?redirect=.
export const load: LayoutServerLoad = async ({ cookies, platform, url }) => {
	const secret = platform?.env?.ADMIN_SECRET;
	if (!secret) {
		return { authed: false, configured: false };
	}
	const expected = await sha256Hex(secret);
	const session = cookies.get(COOKIE);
	if (session !== expected) {
		throw redirect(303, `/admin/login?redirect=${encodeURIComponent(url.pathname)}`);
	}
	return { authed: true };
};
