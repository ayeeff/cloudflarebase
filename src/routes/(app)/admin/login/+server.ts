import { sha256Hex, COOKIE, SESSION_MAX_AGE } from '$lib/server/admin-session';
import type { RequestHandler } from './$types';

// Plain POST endpoint (not a SvelteKit form action, so it is not subject to the
// framework's form-action CSRF origin check that otherwise blocks this Worker
// deployment). Sets the admin session cookie on success.
export const POST: RequestHandler = async ({ request, cookies, platform }) => {
  const secret = platform?.env?.ADMIN_SECRET;
  if (!secret) {
    return new Response(JSON.stringify({ error: 'ADMIN_SECRET is not configured on this deployment.' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });
  }
  let password = '';
  try {
    const form = await request.formData();
    password = String(form.get('password') ?? '');
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid form body.' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });
  }
  const expected = await sha256Hex(secret);
  if ((await sha256Hex(password)) !== expected) {
    return new Response(JSON.stringify({ error: 'Incorrect password.' }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    });
  }
  cookies.set(COOKIE, expected, {
    path: '/',
    maxAge: SESSION_MAX_AGE,
    httpOnly: true,
    sameSite: 'lax'
  });
  return new Response(null, { status: 303, headers: { location: '/admin/maps' } });
};
