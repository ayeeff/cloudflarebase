import { redirect, fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { sha256Hex, COOKIE, SESSION_MAX_AGE } from '$lib/server/admin-session';

// Login landing for the admin console. Unauthenticated visitors are sent here by
// the shared layout; authenticated ones go straight to the maps view.
export const load: PageServerLoad = async ({ cookies, platform }) => {
  const secret = platform?.env?.ADMIN_SECRET;
  if (secret && (await sha256Hex(secret)) === cookies.get(COOKIE)) {
    throw redirect(303, '/admin/maps');
  }
  return { configured: !!secret };
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
