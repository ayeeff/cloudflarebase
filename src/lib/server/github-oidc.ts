import * as Sentry from '@sentry/sveltekit';

/**
 * GitHub Actions OIDC verification (docs/managed-service-design.md, Phase B).
 *
 * This is what lets `build`-mode connections deploy with NO secret anywhere:
 * the workflow asks GitHub for a short-lived identity token describing the
 * repository it is running in, and we verify that token against GitHub's
 * public keys. Nothing is minted, written into the repo, rotated, or leaked -
 * the same mechanism this repository already uses to publish to npm.
 *
 * The token proves the repository. It does NOT prove the project: the caller
 * matches the verified `repository` claim against a stored connection, which
 * is the only thing that says which project a repo may deploy to.
 */

const ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS_URL = `${ISSUER}/.well-known/jwks`;
/** Clock skew tolerance either side of the token's window. */
const SKEW_SECONDS = 60;

/** A GitHub Actions OIDC token, shape-checked before any signature work. */
export const OIDC_TOKEN = /^[\w-]+\.[\w-]+\.[\w-]+$/;

export interface OidcClaims {
	/** `owner/name` of the repository the workflow ran in. */
	repository: string;
	/** Numeric repo id - survives renames, so it is the lookup key. */
	repositoryId: number;
	/** `refs/heads/<branch>` (or a tag/PR ref, which we refuse to deploy). */
	ref: string;
	sha: string;
	/** Default branch at the time of the run - the root/branch decision. */
	repositoryDefaultBranch: string | null;
	actor: string;
	runId: string | null;
}

let jwks = new Map<string, CryptoKey>();
let jwksFetchedAt = 0;
let jwksPending: Promise<void> | null = null;

async function refreshJwks(): Promise<void> {
	if (jwksPending) return jwksPending;
	jwksPending = (async () => {
		const response = await fetch(JWKS_URL, { headers: { 'user-agent': 'cloudflarebase' } });
		if (!response.ok) throw new Error(`JWKS fetch failed with ${response.status}`);
		const body = (await response.json()) as { keys?: Record<string, unknown>[] };
		const next = new Map<string, CryptoKey>();
		for (const jwk of body.keys ?? []) {
			const kid = typeof jwk.kid === 'string' ? jwk.kid : null;
			if (!kid || jwk.kty !== 'RSA') continue;
			try {
				next.set(
					kid,
					await crypto.subtle.importKey(
						'jwk',
						jwk as JsonWebKey,
						{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
						false,
						['verify']
					)
				);
			} catch {
				// One unusable key must not blind us to the rest of the set.
			}
		}
		if (!next.size) throw new Error('JWKS carried no usable RSA keys');
		jwks = next;
		jwksFetchedAt = Date.now();
	})().finally(() => {
		jwksPending = null;
	});
	return jwksPending;
}

/**
 * The verification key for a `kid`, refreshing the key set when it is unknown
 * or stale. GitHub rotates signing keys, so an unknown kid is the expected
 * steady state after a rotation, not an attack - but the refresh is rate
 * limited so a stream of forged kids cannot turn into a fetch amplifier.
 */
async function verificationKey(kid: string): Promise<CryptoKey | null> {
	const age = Date.now() - jwksFetchedAt;
	if (jwks.has(kid) && age < 3_600_000) return jwks.get(kid) ?? null;
	if (!jwks.size || age > 60_000) {
		try {
			await refreshJwks();
		} catch (cause) {
			console.error('github oidc jwks refresh failed', cause);
			Sentry.captureException(cause, { level: 'error', tags: { operation: 'github-oidc-jwks' } });
		}
	}
	return jwks.get(kid) ?? null;
}

function decodeBase64url(segment: string): Uint8Array {
	const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
	const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function decodeSegment(segment: string): unknown {
	return JSON.parse(new TextDecoder().decode(decodeBase64url(segment))) as unknown;
}

/**
 * Verifies an Actions OIDC token and returns its claims, or null.
 *
 * `audience` is this console's origin: GitHub will mint a token for any
 * audience a workflow asks for, so checking it is what stops a token minted
 * for some other service being replayed here.
 */
export async function verifyOidcToken(
	token: string,
	audience: string
): Promise<OidcClaims | null> {
	if (!OIDC_TOKEN.test(token)) return null;
	try {
		const [headerSegment, payloadSegment, signatureSegment] = token.split('.');
		const header = decodeSegment(headerSegment) as { alg?: string; kid?: string };
		// Pinning the algorithm is what refuses `alg: none` and HMAC confusion.
		if (header.alg !== 'RS256' || !header.kid) return null;

		const key = await verificationKey(header.kid);
		if (!key) return null;

		const valid = await crypto.subtle.verify(
			'RSASSA-PKCS1-v1_5',
			key,
			decodeBase64url(signatureSegment) as BufferSource,
			new TextEncoder().encode(`${headerSegment}.${payloadSegment}`) as BufferSource
		);
		if (!valid) return null;

		const claims = decodeSegment(payloadSegment) as Record<string, unknown>;
		const now = Math.floor(Date.now() / 1000);
		if (claims.iss !== ISSUER) return null;
		if (typeof claims.exp !== 'number' || claims.exp + SKEW_SECONDS < now) return null;
		if (typeof claims.nbf === 'number' && claims.nbf - SKEW_SECONDS > now) return null;
		if (typeof claims.iat === 'number' && claims.iat - SKEW_SECONDS > now) return null;

		// `aud` is a string in Actions tokens, but the spec allows an array.
		const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
		if (!audiences.includes(audience)) return null;

		if (typeof claims.repository !== 'string' || typeof claims.ref !== 'string') return null;
		const repositoryId = Number(claims.repository_id);
		if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) return null;

		return {
			repository: claims.repository,
			repositoryId,
			ref: claims.ref,
			sha: typeof claims.sha === 'string' ? claims.sha : '',
			repositoryDefaultBranch:
				typeof claims.repository_default_branch === 'string'
					? claims.repository_default_branch
					: null,
			actor: typeof claims.actor === 'string' ? claims.actor : '',
			runId: typeof claims.run_id === 'string' ? claims.run_id : null
		};
	} catch (cause) {
		console.error('github oidc verification failed', cause);
		Sentry.captureException(cause, { level: 'error', tags: { operation: 'github-oidc-verify' } });
		return null;
	}
}
