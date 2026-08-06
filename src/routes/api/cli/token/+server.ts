import type { RequestHandler } from './$types';

/**
 * Hands the signed-in operator their own session token for CLI use
 * (docs/schema-cli-design.md). The console guard already required a session
 * to reach this route; the response is simply the session cookie's value,
 * which the auth agent accepts as `Authorization: Bearer` - the documented
 * external-client path. No new token store: the CLI holds an ordinary
 * operator session, visible and revocable in the console's sessions table.
 */

const SESSION_COOKIE = 'cfb-console.session_token';

export const POST: RequestHandler = ({ request, url }) => {
	// Belt and braces: the guard's session check plus a same-origin check, so
	// a cross-site form POST can never even execute the handler.
	const origin = request.headers.get('origin');
	if (origin && origin !== url.origin) {
		return Response.json({ error: 'cross-origin request refused' }, { status: 403 });
	}

	// `__Secure-`-prefixed on HTTPS deployments, bare in local dev.
	const token = (request.headers.get('cookie') ?? '')
		.split(';')
		.map((part) => {
			const trimmed = part.trim();
			const eq = trimmed.indexOf('=');
			return eq === -1 ? [trimmed, ''] : [trimmed.slice(0, eq), trimmed.slice(eq + 1)];
		})
		.find(([name]) => name === SESSION_COOKIE || name.endsWith(`-${SESSION_COOKIE}`))?.[1];

	if (!token) {
		return Response.json({ error: 'no console session cookie' }, { status: 401 });
	}
	return Response.json({ token: decodeURIComponent(token) });
};
