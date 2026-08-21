/**
 * Encryption at rest for build secrets - the one place in Cloudflarebase where
 * a secret VALUE must be stored and later recovered (the GitHub Actions
 * runner fetches it at build time), so hashing and write-through both fall
 * short. Everything else stays hashed or write-through; reach for this only
 * when a value genuinely has to come back out.
 *
 * AES-256-GCM under a master key derived from the `HOSTING_MASTER_KEY`
 * wrangler secret. The stored format is versioned (`v1:<iv>:<ciphertext>`)
 * so a key or algorithm rotation can introduce `v2` while still reading old
 * rows. Ciphertexts are bound to their row via GCM's additional data
 * (`<appName>\0<name>`): a value copied between rows fails authentication
 * instead of decrypting under the wrong name.
 */

const VERSION = 'v1';

function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
	const padded = value.replaceAll('-', '+').replaceAll('_', '/');
	const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * SHA-256 of the secret string as the raw AES-256 key. The env secret is
 * high-entropy operator input, not a password, so a KDF with salt/stretching
 * would add parameters without adding security.
 */
export async function importMasterKey(secret: string): Promise<CryptoKey> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
	return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Encrypts to `v1:<base64url(iv)>:<base64url(ciphertext+tag)>`, fresh random
 * 12-byte IV per call - two encryptions of the same value never match. */
export async function encryptValue(
	key: CryptoKey,
	plaintext: string,
	aad: string,
): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) },
		key,
		new TextEncoder().encode(plaintext),
	);
	return `${VERSION}:${toBase64Url(iv)}:${toBase64Url(new Uint8Array(ciphertext))}`;
}

/** Throws on an unknown version, malformed input, a wrong key, a wrong AAD,
 * or any bit of tampering - GCM authenticates before it decrypts. */
export async function decryptValue(key: CryptoKey, stored: string, aad: string): Promise<string> {
	const [version, iv, ciphertext, ...rest] = stored.split(':');
	if (version !== VERSION || !iv || !ciphertext || rest.length) {
		throw new Error(`unsupported ciphertext format "${stored.slice(0, 8)}"`);
	}
	const plaintext = await crypto.subtle.decrypt(
		{
			name: 'AES-GCM',
			iv: fromBase64Url(iv),
			additionalData: new TextEncoder().encode(aad),
		},
		key,
		fromBase64Url(ciphertext),
	);
	return new TextDecoder().decode(plaintext);
}
