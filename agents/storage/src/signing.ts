/**
 * Signed download URLs (docs/storage-agent-plan.md, "The byte paths").
 *
 * A signed URL is the answer to "I need a plain URL for a private object" -
 * the thing an `<img src>` can hold, with no Authorization header available.
 * It BYPASSES the bucket's read mode at serve time, which is its entire
 * purpose, so minting requires exactly what reading requires and nothing is
 * mintable that is not readable by the caller at that moment.
 *
 * Three properties this module exists to hold:
 *
 * - **Zero DO hops to verify.** The secret rides the same cached parent
 *   answer the access check already reads, so a signed GET costs no more than
 *   an unsigned one. That is what makes a private image viable in an
 *   `<img src>` at all.
 * - **The signature covers project, bucket, key, method, and expiry - never
 *   the host.** One URL therefore verifies on the agent path and on
 *   `STORAGE_SERVE_DOMAIN` alike, and the two spellings cannot drift apart.
 *   Leaving the host out is safe because pid and bucket are both inside the
 *   payload: a signature cannot be replayed against another tenant.
 * - **Rotation is the revocation mechanism.** `v` names the secret version
 *   that signed; bumping the version invalidates every outstanding URL at
 *   once. It converges within the access-cache TTL rather than instantly, and
 *   that direction matters: a verifier meeting a version it does NOT hold
 *   refetches once (so a URL minted from the new secret works immediately,
 *   even against a stale isolate), but an OLD url against a stale isolate
 *   still matches the version that isolate holds and is served until that
 *   entry expires. Revocation is therefore bounded by the cache window, the
 *   same bargain every restrictive change in this agent makes - stated, not
 *   hidden. Any request carrying the new version pulls that isolate forward.
 *
 * GET and HEAD only. Write capabilities stay out by design (Non-goals):
 * uploads have a protocol, and presigned direct-to-R2 is S2.5's transport.
 */

/** 7 days. No URL should outlive the decision to mint it by much. */
export const SIGNED_URL_MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
export const SIGNED_URL_DEFAULT_TTL_SECONDS = 60 * 60;

/** Query parameters a signed URL carries. */
export const SIGNED_PARAM_VERSION = 'v';
export const SIGNED_PARAM_EXPIRES = 'exp';
export const SIGNED_PARAM_SIGNATURE = 'sig';

export type SignedMethod = 'GET' | 'HEAD';

/** The agent-held signing secret. Version 0 is reserved for an operator-supplied
 * env value; generated secrets start at 1 and increment on rotation. */
export interface SigningSecret {
	version: number;
	secret: string;
}

export interface SignatureSubject {
	projectId: string;
	bucket: string;
	/** The CANONICAL key (post `parseObjectKey`), so mint and verify agree. */
	key: string;
	method: SignedMethod;
	/** Unix seconds. */
	expires: number;
}

export interface SignedParams {
	version: number;
	expires: number;
	signature: string;
}

/**
 * NUL-separated because no field can contain one: project ids and bucket
 * names are DNS-label charset, object keys are refused if they carry control
 * characters (`keys.ts`), method is a fixed enum, and expiry is digits. So the
 * payload is unambiguous by construction and no field can be smuggled into
 * the next one.
 */
export function signaturePayload(subject: SignatureSubject): string {
	return [
		subject.projectId,
		subject.bucket,
		subject.key,
		subject.method,
		String(subject.expires),
	].join('\0');
}

function base64url(bytes: ArrayBuffer): string {
	const binary = String.fromCharCode(...new Uint8Array(bytes));
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
}

export async function signSubject(secret: string, subject: SignatureSubject): Promise<string> {
	const key = await hmacKey(secret);
	const mac = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(signaturePayload(subject)),
	);
	return base64url(mac);
}

/**
 * Length-independent equality. `crypto.subtle.verify` would do this for us,
 * but it needs the signature decoded back to bytes and a malformed base64url
 * would throw where a plain mismatch should just be false.
 */
function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let index = 0; index < a.length; index += 1) {
		diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
	}
	return diff === 0;
}

/** Whether the URL carries a signature at all - cheap, and the gate for
 * everything else (an unsigned request must never pay a signing cost). */
export function hasSignedParams(url: URL): boolean {
	return url.searchParams.has(SIGNED_PARAM_SIGNATURE);
}

/** Parse and range-check the signature parameters. Null = malformed, which
 * callers treat exactly like an absent signature: no bypass, ordinary gate. */
export function parseSignedParams(url: URL): SignedParams | null {
	const signature = url.searchParams.get(SIGNED_PARAM_SIGNATURE);
	const rawVersion = url.searchParams.get(SIGNED_PARAM_VERSION);
	const rawExpires = url.searchParams.get(SIGNED_PARAM_EXPIRES);
	if (!signature || !rawVersion || !rawExpires) return null;
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(signature)) return null;
	if (!/^\d{1,10}$/.test(rawVersion) || !/^\d{1,15}$/.test(rawExpires)) return null;
	return { version: Number(rawVersion), expires: Number(rawExpires), signature };
}

export type SignatureVerdict =
	{ ok: true } | { ok: false; reason: 'expired' | 'mismatch' | 'version' };

/**
 * Verify a parsed signature against the held secret. The version check comes
 * FIRST and is reported distinctly, because the caller's response to it is to
 * refetch the secret once rather than to refuse - a rotation must not read as
 * a forgery.
 */
export async function verifySignature(
	held: SigningSecret,
	params: SignedParams,
	subject: Omit<SignatureSubject, 'expires'>,
	nowSeconds: number,
): Promise<SignatureVerdict> {
	if (params.version !== held.version) return { ok: false, reason: 'version' };
	if (params.expires <= nowSeconds) return { ok: false, reason: 'expired' };
	const expected = await signSubject(held.secret, { ...subject, expires: params.expires });
	if (!constantTimeEqual(expected, params.signature)) return { ok: false, reason: 'mismatch' };
	return { ok: true };
}

/** Clamp a requested TTL into the allowed window. */
export function resolveTtlSeconds(requested: number | undefined): number {
	if (requested === undefined) return SIGNED_URL_DEFAULT_TTL_SECONDS;
	return Math.min(Math.max(Math.floor(requested), 1), SIGNED_URL_MAX_TTL_SECONDS);
}

/**
 * A freshly minted secret. 32 bytes of CSPRNG, hex - long enough that the
 * HMAC key is not the weak link and printable so it survives an env var
 * round trip unchanged.
 */
export function mintSecret(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return Array.from(bytes)
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}
