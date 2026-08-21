import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

const COOKIE = 'cfb-admin-session';
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Shared layout for all /admin/* sub-routes. Verifies the cfb-admin-session
// cookie (set by the /admin login form) and redirects to /admin if missing.
export const load: LayoutServerLoad = async ({ cookies, platform }) => {
  const secret = platform?.env?.ADMIN_SECRET;
  if (!secret) {
    return { authed: false, configured: false };
  }
  const expected = await sha256Hex(secret);
  const session = cookies.get(COOKIE);
  if (session !== expected) {
    throw redirect(303, '/admin');
  }
  return { authed: true, configured: true };
};
