/**
 * Signed download URLs ("The byte paths").
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
		// Context label. One generated secret signs both download URLs and
		// upload envelopes, so each payload names which protocol it belongs to
		// - without it, a value signed for one could be replayed as the other.
		'url',
		subject.projectId,
		subject.bucket,
		subject.key,
		subject.method,
		String(subject.expires),
	].join('\0');
}

/**
 * A multipart upload capability. `resumeMultipartUpload()` validates NOTHING -
 * not even that the upload exists - so the raw R2 upload id must never be the
 * client-visible capability. This envelope is: it carries every fact a part
 * `PUT` needs, so parts verify statelessly with zero DO hops, and it is bound
 * to one project, bucket, key, and part size, so it cannot be steered at
 * another tenant's upload.
 */
export interface UploadEnvelope {
	projectId: string;
	bucket: string;
	key: string;
	/** OUR reservation id (the parent's `uploads` row), so complete and abort
	 * can settle the right reservation without a lookup by key. */
	reservationId: string;
	/** R2's own id. Never leaves the worker except inside the sealed envelope. */
	r2UploadId: string;
	partSize: number;
	/** Declared total, which is what tells the worker which part is last. */
	size: number;
	contentType: string;
	owner: string;
	/** Unix seconds. Outliving the parent's 24h sweep means a swept upload's
	 * parts die at the signature check rather than as an R2 error to interpret. */
	expires: number;
}

export function uploadPayload(envelope: UploadEnvelope): string {
	return [
		'upload',
		envelope.projectId,
		envelope.bucket,
		envelope.key,
		envelope.reservationId,
		envelope.r2UploadId,
		String(envelope.partSize),
		String(envelope.size),
		envelope.contentType,
		envelope.owner,
		String(envelope.expires),
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
	| { ok: true }
	| { ok: false; reason: 'expired' | 'mismatch' }
	/** Both versions ride along so the caller can compare them without parsing
	 * the URL itself - see `mayRefetchForVersion`. */
	| { ok: false; reason: 'version'; version: number; held: number };

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
	if (params.version !== held.version) {
		return { ok: false, reason: 'version', version: params.version, held: held.version };
	}
	if (params.expires <= nowSeconds) return { ok: false, reason: 'expired' };
	const expected = await signSubject(held.secret, { ...subject, expires: params.expires });
	if (!constantTimeEqual(expected, params.signature)) return { ok: false, reason: 'mismatch' };
	return { ok: true };
}

export const FORCED_REFETCH_COOLDOWN_MS = 5_000;

/**
 * Whether a version mismatch has earned an uncached hop to the coordinator DO.
 * The version is caller input checked before the signature, so this is the one
 * cache bypass an unauthenticated request can reach - and it lands on a
 * single-threaded object (issue #72). Two gates, and the second carries the
 * weight: versions only increment, so `requested <= held` is a retired secret
 * or a forgery and is refused free - but a forgery can name an arbitrarily
 * HIGH version, so only the cooldown actually bounds a flood.
 *
 * `lastForcedAt` counts FORCED refetches, never ordinary cache refills, so an
 * isolate's first sight of a new version always asks. That is the rotation
 * case: mint and serve are usually different isolates in different colos.
 */
export function mayRefetchForVersion(
	requested: number,
	held: number,
	lastForcedAt: number | undefined,
	now: number,
): boolean {
	if (requested <= held) return false;
	if (lastForcedAt !== undefined && lastForcedAt + FORCED_REFETCH_COOLDOWN_MS > now) return false;
	return true;
}

/** Clamp a requested TTL into the allowed window. */
export function resolveTtlSeconds(requested: number | undefined): number {
	if (requested === undefined) return SIGNED_URL_DEFAULT_TTL_SECONDS;
	return Math.min(Math.max(Math.floor(requested), 1), SIGNED_URL_MAX_TTL_SECONDS);
}

/** R2 refuses parts under 5 MiB (except the last) and caps an upload at
 * 10,000 parts. The floor keeps part counts sane above that minimum; the
 * ceiling keeps a PROXIED part inside the Workers request-body cap. */
export const MIN_PART_SIZE = 8 * 1024 * 1024;
export const MAX_PART_SIZE = 95 * 1024 * 1024;
export const MAX_PARTS = 10_000;
/** Multipart ceiling for one object. */
export const MAX_MULTIPART_BYTES = 5 * 1024 * 1024 * 1024;
/** An upload capability outlives the parent's 24h sweep by an hour, so a
 * swept upload fails its signature check rather than R2's own lookup. */
export const UPLOAD_TTL_SECONDS = 25 * 60 * 60;

/**
 * Part size is SERVER-dictated, never client-chosen: R2 requires every part
 * but the last to be identical, so letting a client pick invites an upload
 * that cannot complete. Declared size over the part ceiling, rounded up to a
 * whole MiB, clamped into the allowed window.
 */
export function resolvePartSize(size: number): number {
	const needed = Math.ceil(size / MAX_PARTS);
	const rounded = Math.ceil(needed / (1024 * 1024)) * 1024 * 1024;
	return Math.min(Math.max(rounded, MIN_PART_SIZE), MAX_PART_SIZE);
}

/** How many parts a declared size becomes at this part size. */
export function partCount(size: number, partSize: number): number {
	return Math.max(Math.ceil(size / partSize), 1);
}

/**
 * Seal an envelope into one opaque wire token: the fields, then the signature
 * over them. The fields travel in the clear because the worker needs them
 * WITHOUT a DO hop - the signature is what makes them trustworthy, not
 * secrecy. Nothing in here is confidential; the R2 upload id is useless
 * without the account's own binding.
 */
export async function sealUpload(held: SigningSecret, envelope: UploadEnvelope): Promise<string> {
	const key = await hmacKey(held.secret);
	const mac = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(uploadPayload(envelope)),
	);
	const body = btoa(JSON.stringify(envelope))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
	return `${held.version}.${body}.${base64url(mac)}`;
}

export type UploadVerdict =
	| { ok: true; envelope: UploadEnvelope }
	| { ok: false; reason: 'malformed' | 'expired' | 'mismatch' }
	| { ok: false; reason: 'version'; version: number; held: number };

/** Open a sealed envelope. Same version-first ordering as a download
 * signature, and for the same reason: a rotation is not a forgery. */
export async function openUpload(
	held: SigningSecret,
	token: string,
	nowSeconds: number,
): Promise<UploadVerdict> {
	const parts = token.split('.');
	if (parts.length !== 3) return { ok: false, reason: 'malformed' };
	const [rawVersion, body, signature] = parts;
	if (!/^\d{1,10}$/.test(rawVersion)) return { ok: false, reason: 'malformed' };
	if (Number(rawVersion) !== held.version) {
		return { ok: false, reason: 'version', version: Number(rawVersion), held: held.version };
	}

	let envelope: UploadEnvelope;
	try {
		const padded = body.replace(/-/g, '+').replace(/_/g, '/');
		envelope = JSON.parse(atob(padded)) as UploadEnvelope;
	} catch {
		return { ok: false, reason: 'malformed' };
	}
	if (
		typeof envelope?.projectId !== 'string' ||
		typeof envelope?.bucket !== 'string' ||
		typeof envelope?.key !== 'string' ||
		typeof envelope?.reservationId !== 'string' ||
		typeof envelope?.r2UploadId !== 'string' ||
		typeof envelope?.contentType !== 'string' ||
		typeof envelope?.owner !== 'string' ||
		typeof envelope?.partSize !== 'number' ||
		typeof envelope?.size !== 'number' ||
		typeof envelope?.expires !== 'number'
	) {
		return { ok: false, reason: 'malformed' };
	}
	// The signature is an HMAC over the NUL-JOINED fields, so the join is only
	// injective while no field can contain the separator. A NUL smuggled into
	// one field (mint validates most of them, but the envelope must not depend
	// on that) would let the same signed bytes be re-sliced into different
	// field values - a forged owner, a shifted expiry.
	if (
		[
			envelope.projectId,
			envelope.bucket,
			envelope.key,
			envelope.reservationId,
			envelope.r2UploadId,
			envelope.contentType,
			envelope.owner,
		].some((field) => field.includes('\0'))
	) {
		return { ok: false, reason: 'malformed' };
	}

	// Signature BEFORE expiry, unlike a download URL: the fields being checked
	// against the clock are themselves attacker-supplied until verified.
	const expected = await signSubjectRaw(held.secret, uploadPayload(envelope));
	if (!constantTimeEqual(expected, signature)) return { ok: false, reason: 'mismatch' };
	if (envelope.expires <= nowSeconds) return { ok: false, reason: 'expired' };
	return { ok: true, envelope };
}

async function signSubjectRaw(secret: string, payload: string): Promise<string> {
	const key = await hmacKey(secret);
	return base64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
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

/**
 * The origin to hand out in URLs, or null when there is none to hand out.
 *
 * Takes the two facts separately on purpose: a serving domain being SET means
 * this Worker answers on that Host, and says NOTHING about whether a browser
 * can reach it. Only `routed` licenses putting it in a URL.
 */
export function publicServeOrigin(env: {
	STORAGE_SERVE_DOMAIN?: string;
	STORAGE_SERVE_DOMAIN_ROUTED?: string;
}): string | null {
	const domain = env.STORAGE_SERVE_DOMAIN?.trim();
	if (!domain) return null;
	if (env.STORAGE_SERVE_DOMAIN_ROUTED !== 'true') return null;
	return `https://${domain}`;
}

/** The serving-domain path for an object: `/<projectId>/<bucket>/<key>`. The
 * `p/` prefix that keys it inside R2 is composed by this Worker and never
 * appears in a URL. */
export function serveObjectPath(projectId: string, bucket: string, key: string): string {
	const encodedKey = key.split('/').map(encodeURIComponent).join('/');
	return `/${encodeURIComponent(projectId)}/${encodeURIComponent(bucket)}/${encodedKey}`;
}

/** The agent-path spelling of the same object, on a given origin. */
export function agentObjectUrl(
	origin: string,
	projectId: string,
	bucket: string,
	key: string,
): string {
	const encodedKey = key.split('/').map(encodeURIComponent).join('/');
	return `${origin}/agents/storage-agent/${encodeURIComponent(projectId)}/buckets/${encodeURIComponent(bucket)}/objects/${encodedKey}`;
}
