import assert from 'node:assert/strict';
import test from 'node:test';
import {
	SIGNED_URL_MAX_TTL_SECONDS,
	hasSignedParams,
	mintSecret,
	parseSignedParams,
	resolveTtlSeconds,
	signSubject,
	signaturePayload,
	verifySignature,
	type SignatureSubject,
	type SigningSecret,
} from './signing';

const HELD: SigningSecret = { version: 3, secret: 'a'.repeat(64) };
const NOW = 1_760_000_000;

const SUBJECT: Omit<SignatureSubject, 'expires'> = {
	projectId: 'proj-one',
	bucket: 'avatars',
	key: 'users/u1/photo.png',
	method: 'GET',
};

async function signedParamsFor(
	overrides: Partial<SignatureSubject> = {},
	secret = HELD,
): Promise<{ version: number; expires: number; signature: string }> {
	const expires = overrides.expires ?? NOW + 600;
	const signature = await signSubject(secret.secret, { ...SUBJECT, ...overrides, expires });
	return { version: secret.version, expires, signature };
}

test('a signature minted for a subject verifies for that subject', async () => {
	const params = await signedParamsFor();
	assert.deepEqual(await verifySignature(HELD, params, SUBJECT, NOW), { ok: true });
});

test('the payload is NUL-separated so no field can bleed into the next', () => {
	// `bucket` cannot contain a slash and keys cannot contain NUL, so the only
	// way these two could collide is a separator that appears in real data.
	const a = signaturePayload({ ...SUBJECT, bucket: 'a', key: 'b/c', expires: 1 });
	const b = signaturePayload({ ...SUBJECT, bucket: 'a/b', key: 'c', expires: 1 });
	assert.notEqual(a, b);
	assert.ok(a.includes('\0'));
});

test('every signed field is covered: changing any one breaks the signature', async () => {
	const params = await signedParamsFor();
	const tampered: Array<Partial<typeof SUBJECT>> = [
		{ projectId: 'proj-two' },
		{ bucket: 'private' },
		{ key: 'users/u2/photo.png' },
		{ method: 'HEAD' },
	];
	for (const change of tampered) {
		const verdict = await verifySignature(HELD, params, { ...SUBJECT, ...change }, NOW);
		assert.deepEqual(verdict, { ok: false, reason: 'mismatch' }, JSON.stringify(change));
	}
});

test('a tampered expiry does not verify, so a URL cannot extend itself', async () => {
	const params = await signedParamsFor();
	const verdict = await verifySignature(
		HELD,
		{ ...params, expires: params.expires + 86_400 },
		SUBJECT,
		NOW,
	);
	assert.deepEqual(verdict, { ok: false, reason: 'mismatch' });
});

test('expiry is enforced, and the boundary second is already expired', async () => {
	const params = await signedParamsFor({ expires: NOW });
	assert.deepEqual(await verifySignature(HELD, params, SUBJECT, NOW), {
		ok: false,
		reason: 'expired',
	});
});

test('a different secret at the same version does not verify', async () => {
	const params = await signedParamsFor({}, { version: 3, secret: 'b'.repeat(64) });
	assert.deepEqual(await verifySignature(HELD, params, SUBJECT, NOW), {
		ok: false,
		reason: 'mismatch',
	});
});

test('a version mismatch reports `version`, never `mismatch`', async () => {
	// The caller refetches on `version` and refuses on `mismatch`, so conflating
	// them turns a routine rotation into a hard failure for every live URL.
	const params = await signedParamsFor({}, { version: 2, secret: HELD.secret });
	assert.deepEqual(await verifySignature(HELD, params, SUBJECT, NOW), {
		ok: false,
		reason: 'version',
	});
});

test('rotation invalidates outstanding URLs', async () => {
	const params = await signedParamsFor();
	const rotated: SigningSecret = { version: 4, secret: mintSecret() };
	const verdict = await verifySignature(rotated, params, SUBJECT, NOW);
	assert.equal(verdict.ok, false);
});

test('signed parameters parse only in their expected shapes', () => {
	const base = 'https://cdn.example.com/p/b/k';
	assert.equal(parseSignedParams(new URL(`${base}?v=1&exp=99&sig=abc`))?.expires, 99);
	// Missing any one of the three is not a signed URL.
	assert.equal(parseSignedParams(new URL(`${base}?v=1&exp=99`)), null);
	assert.equal(parseSignedParams(new URL(`${base}?exp=99&sig=abc`)), null);
	assert.equal(parseSignedParams(new URL(`${base}?v=1&sig=abc`)), null);
	// Non-numeric or over-long fields are refused rather than coerced.
	assert.equal(parseSignedParams(new URL(`${base}?v=x&exp=99&sig=abc`)), null);
	assert.equal(parseSignedParams(new URL(`${base}?v=1&exp=9.5&sig=abc`)), null);
	assert.equal(parseSignedParams(new URL(`${base}?v=1&exp=99&sig=a+b`)), null);
});

test('a request is only treated as signed when it carries a signature', () => {
	assert.equal(hasSignedParams(new URL('https://cdn.example.com/p/b/k')), false);
	assert.equal(hasSignedParams(new URL('https://cdn.example.com/p/b/k?v=1&exp=2')), false);
	assert.equal(hasSignedParams(new URL('https://cdn.example.com/p/b/k?sig=abc')), true);
});

test('expiry windows clamp into the allowed range', () => {
	assert.equal(resolveTtlSeconds(undefined), 3600);
	assert.equal(resolveTtlSeconds(60), 60);
	assert.equal(resolveTtlSeconds(0), 1);
	assert.equal(resolveTtlSeconds(-100), 1);
	assert.equal(resolveTtlSeconds(90.7), 90);
	// Capped rather than refused: a caller asking for a year gets seven days.
	assert.equal(resolveTtlSeconds(365 * 24 * 3600), SIGNED_URL_MAX_TTL_SECONDS);
});

test('minted secrets are 32 bytes of hex and do not repeat', () => {
	const first = mintSecret();
	assert.match(first, /^[0-9a-f]{64}$/);
	assert.notEqual(first, mintSecret());
});

test('signatures are URL-safe, so the query string survives a round trip', async () => {
	const { signature } = await signedParamsFor();
	assert.match(signature, /^[A-Za-z0-9_-]+$/);
	const url = new URL(`https://cdn.example.com/p/b/k?sig=${signature}`);
	assert.equal(url.searchParams.get('sig'), signature);
});
