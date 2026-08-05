import type { ProjectJwtVerifier } from './jwt';
import { hasPermission } from './rules';
import type { AccessMode } from './schemas';

/**
 * The access gate and CORS policy shared by DbCollection and DbTable -
 * extracted (not copied) so the two engines can never drift on who gets in.
 * Behavior is exactly the collection v1 gate:
 *
 * - `public` mode: straight through, no token looked at.
 * - `auth`/`owner`: Bearer token required (401 without), verified against
 *   the project JWKS (401 invalid, 503 when verification is unconfigured),
 *   then the optional permission key is checked - a VALID token lacking the
 *   key gets 403, distinct from the tokenless 401.
 * - `owner` resolves to the token's subject, scoping every read and write.
 */

export type AccessDecision =
	| { ok: true; owner: string | null }
	| { ok: false; response: Response };

export async function checkAccess(
	request: Request,
	mode: AccessMode,
	permission: string | null,
	verifier: ProjectJwtVerifier,
): Promise<AccessDecision> {
	if (mode === 'public') return { ok: true, owner: null };

	const header = request.headers.get('authorization');
	const token = header?.match(/^Bearer (.+)$/i)?.[1];
	if (!token) {
		return {
			ok: false,
			response: Response.json({ error: 'a project token is required' }, { status: 401 }),
		};
	}

	const result = await verifier.verify(token);
	if (!result.ok) {
		if (result.code === 'not-configured') {
			return {
				ok: false,
				response: Response.json(
					{ error: 'auth verification is not configured' },
					{ status: 503 },
				),
			};
		}
		return {
			ok: false,
			response: Response.json({ error: 'invalid or expired token' }, { status: 401 }),
		};
	}

	// 403, not 401: the token is valid, it just lacks the right.
	if (!hasPermission(permission, result.claims.permissions)) {
		return {
			ok: false,
			response: Response.json(
				{ error: 'the token does not carry the required permission' },
				{ status: 403 },
			),
		};
	}

	return { ok: true, owner: mode === 'owner' ? result.claims.sub : null };
}

/**
 * Exact-origin CORS echo over the deployment's own origin, environment
 * TRUSTED_ORIGINS, and the project's allowed origins - null means the origin
 * is untrusted (callers answer 403 for browser requests carrying one).
 */
export function corsHeadersFor(
	request: Request,
	trustedOriginsVar: string | undefined,
	allowedOrigins: string[],
): Headers | null {
	const origin = request.headers.get('origin');
	const sameOrigin = origin === new URL(request.url).origin;
	const trusted = [
		...(trustedOriginsVar ?? '')
			.split(',')
			.map((entry) => entry.trim())
			.filter(Boolean),
		...allowedOrigins,
	];
	if (!origin || (!sameOrigin && !trusted.includes(origin))) return null;
	return new Headers({
		'access-control-allow-origin': origin,
		'access-control-allow-credentials': 'true',
		'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
		'access-control-allow-headers': 'authorization, content-type',
		vary: 'Origin',
	});
}

/** Apply CORS to a routed response without mutating the original. */
export function withCors(response: Response, cors: Headers | null): Response {
	if (!cors) return response;
	const headers = new Headers(response.headers);
	cors.forEach((value, key) => headers.set(key, value));
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
