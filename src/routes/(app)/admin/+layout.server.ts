import type { LayoutServerLoad } from './$types';
import { sha256Hex, COOKIE } from '$lib/server/admin-session';

// Shared layout for all /admin/* sub-routes. Verifies the cfb-admin-session
// cookie (set by the login action on /admin) and renders the login form via
// the layout when missing.
export const load: LayoutServerLoad = async ({ cookies, platform }) => {
  const secret = platform?.env?.ADMIN_SECRET;
  if (!secret) {
    return { authed: false, configured: false };
  }
  const expected = await sha256Hex(secret);
  const session = cookies.get(COOKIE);
  return { authed: session === expected, configured: true };
};
