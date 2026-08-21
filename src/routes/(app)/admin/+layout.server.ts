import { redirect, fail } from '@sveltejs/kit';
import type { LayoutServerLoad, Actions } from './$types';

const COOKIE = 'cfb-admin-session';
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Shared layout for all /admin/* sub-routes. Verifies the cfb-admin-session
// cookie (set by the login action below) and renders the login form via the
// layout when missing.
export const load: LayoutServerLoad = async ({ cookies, platform }) => {
  const secret = platform?.env?.ADMIN_SECRET;
  if (!secret) {
    return { authed: false, configured: false };
  }
  const expected = await sha256Hex(secret);
  const session = cookies.get(COOKIE);
  return { authed: session === expected, configured: true };
};

export const actions: Actions = {
  login: async ({ request, cookies, platform }) => {
    const secret = platform?.env?.ADMIN_SECRET;
    if (!secret) {
      return fail(400, { error: 'ADMIN_SECRET is not configured on this deployment.' });
    }
    const form = await request.formData();
    const password = String(form.get('password') ?? '');
    const expected = await sha256Hex(secret);
    if ((await sha256Hex(password)) !== expected) {
      return fail(401, { error: 'Incorrect password.' });
    }
    cookies.set(COOKIE, expected, {
      path: '/',
      maxAge: SESSION_MAX_AGE,
      httpOnly: true,
      sameSite: 'lax'
    });
    throw redirect(303, '/admin/maps');
  },
  logout: async ({ cookies }) => {
    cookies.delete(COOKIE, { path: '/' });
    throw redirect(303, '/admin');
  }
};
