import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { sha256Hex, COOKIE } from '$lib/server/admin-session';

// Login landing for the admin console. Unauthenticated visitors are sent here by
// the shared layout; authenticated ones go straight to the maps view.
export const load: PageServerLoad = async ({ cookies, platform }) => {
  const secret = platform?.env?.ADMIN_SECRET;
  if (secret && (await sha256Hex(secret)) === cookies.get(COOKIE)) {
    throw redirect(303, '/admin/maps');
  }
  return { configured: !!secret };
};
