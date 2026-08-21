import { COOKIE } from '$lib/server/admin-session';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ cookies }) => {
  cookies.delete(COOKIE, { path: '/' });
  return new Response(null, { status: 303, headers: { location: '/admin' } });
};
