import * as Sentry from '@sentry/sveltekit';

/**
 * GitHub App plumbing for push-to-deploy (* Phase B). Everything here is control-plane: the hosting agent never learns
 * that GitHub exists, it only ever receives an already-resolved subdomain and
 * a deploy body - the same contract the console's own deploy route uses.
 *
 * The App replaces the manual "paste a token, commit a workflow" setup with
 * one install. It still does NOT mean we run a build farm: `build` mode has
 * GitHub's runners build and deploy (trusted by OIDC, so no repo secret
 * exists), and `direct` mode deploys the pushed tree with no runner at all.
 *
 * Every credential is optional. Unconfigured is the self-hosted default: the
 * Hosting page falls back to the manual deploy-token flow and nothing here is
 * ever called.
 */

export interface GithubAppConfig {
	/** Numeric App id, the JWT `iss`. */
	appId: string;
	/** URL slug, for `https://github.com/apps/<slug>/installations/new`. */
	slug: string;
	privateKeyPem: string;
	webhookSecret: string;
}

export const GITHUB_API = 'https://api.github.com';

/** `owner/name`, GitHub's own charset for both halves. */
export const REPO_FULL_NAME = /^[\w.-]+\/[\w.-]+$/;

/**
 * The App's credentials, or null when this deployment has no App configured.
 * All four are required together - a half-configured App would fail at the
 * least helpful moment, so it reads as unconfigured instead.
 */
export function githubAppConfig(platform: App.Platform | undefined): GithubAppConfig | null {
	const env = platform?.env;
	const appId = env?.GITHUB_APP_ID?.trim();
	const slug = env?.GITHUB_APP_SLUG?.trim();
	const privateKeyPem = env?.GITHUB_APP_PRIVATE_KEY?.trim();
	const webhookSecret = env?.GITHUB_APP_WEBHOOK_SECRET?.trim();
	if (!appId || !slug || !privateKeyPem || !webhookSecret) return null;
	return { appId, slug, privateKeyPem, webhookSecret };
}

// --- DER / PEM -------------------------------------------------------------

/** AlgorithmIdentifier for rsaEncryption, with its NULL parameters. */
const RSA_ENCRYPTION_OID = [
	0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00
];

function derLength(length: number): number[] {
	if (length < 0x80) return [length];
	const bytes: number[] = [];
	for (let remaining = length; remaining > 0; remaining = Math.floor(remaining / 256)) {
		bytes.unshift(remaining % 256);
	}
	return [0x80 | bytes.length, ...bytes];
}

function derTlv(tag: number, contents: Uint8Array): Uint8Array {
	return new Uint8Array([tag, ...derLength(contents.length), ...contents]);
}

/**
 * Wraps a PKCS#1 `RSAPrivateKey` in a PKCS#8 `PrivateKeyInfo`.
 *
 * GitHub hands out PKCS#1 (`BEGIN RSA PRIVATE KEY`) and WebCrypto imports
 * only PKCS#8, so without this every operator would have to run `openssl
 * pkcs8` before pasting the key - a setup step that fails silently and looks
 * like a bad key. The wrapper is a fixed prefix plus the original bytes.
 */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
	return derTlv(
		0x30,
		new Uint8Array([
			0x02,
			0x01,
			0x00, // version 0
			...RSA_ENCRYPTION_OID,
			...derTlv(0x04, pkcs1) // privateKey OCTET STRING
		])
	);
}

function decodeBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function base64url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PEM text -> PKCS#8 DER, accepting either of GitHub's key encodings. */
function pemToPkcs8(pem: string): Uint8Array {
	const match = pem.match(/-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END/);
	if (!match) {
		throw new Error('GITHUB_APP_PRIVATE_KEY is not a PEM private key');
	}
	const der = decodeBase64(match[2].replace(/\s+/g, ''));
	return match[1] ? pkcs1ToPkcs8(der) : der;
}

const signingKeys = new Map<string, Promise<CryptoKey>>();

function signingKey(pem: string): Promise<CryptoKey> {
	let pending = signingKeys.get(pem);
	if (!pending) {
		pending = crypto.subtle
			.importKey(
				'pkcs8',
				pemToPkcs8(pem) as BufferSource,
				{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
				false,
				['sign']
			)
			.catch((cause: unknown) => {
				signingKeys.delete(pem);
				throw cause;
			});
		signingKeys.set(pem, pending);
	}
	return pending;
}

// --- App and installation credentials --------------------------------------

const appJwts = new Map<string, { token: string; expiresAt: number }>();

/**
 * The App-level JWT, RS256 over the App id. `iat` is backdated a minute
 * because GitHub rejects tokens issued in its future and Workers clocks are
 * not the operator's; `exp` stays inside GitHub's 10-minute ceiling.
 */
export async function appJwt(config: GithubAppConfig): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const cached = appJwts.get(config.appId);
	if (cached && cached.expiresAt > now + 30) return cached.token;

	const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
	const expiresAt = now + 540;
	const payload = base64url(
		new TextEncoder().encode(JSON.stringify({ iat: now - 60, exp: expiresAt, iss: config.appId }))
	);
	const signature = await crypto.subtle.sign(
		'RSASSA-PKCS1-v1_5',
		await signingKey(config.privateKeyPem),
		new TextEncoder().encode(`${header}.${payload}`) as BufferSource
	);
	const token = `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
	appJwts.set(config.appId, { token, expiresAt });
	return token;
}

const installationTokens = new Map<number, { token: string; expiresAt: number }>();

export type InstallationTokenResult = { token: string } | { token: null; status: number };

/**
 * An installation access token (1 hour, scoped to the repos the operator
 * selected at install time). Cached per isolate until a minute before expiry.
 *
 * A failed mint keeps GitHub's status, because it distinguishes three answers
 * the callers must not conflate: 404 is authoritative "this installation no
 * longer exists" (the App JWT authenticated, or it would be 401 - so the row
 * is safe to prune), 403 is suspended (reversible, never prune), and anything
 * else is GitHub being unreachable - a fact about the network, not about the
 * installation, so it must never read as "reinstall the app".
 */
export async function mintInstallationToken(
	config: GithubAppConfig,
	installationId: number
): Promise<InstallationTokenResult> {
	const now = Date.now();
	const cached = installationTokens.get(installationId);
	if (cached && cached.expiresAt > now + 60_000) return { token: cached.token };

	const response = await githubFetch(
		await appJwt(config),
		'POST',
		`/app/installations/${installationId}/access_tokens`
	);
	const body = response.body as { token?: string; expires_at?: string } | null;
	if (!response.ok || !body?.token) {
		return { token: null, status: response.status };
	}
	installationTokens.set(installationId, {
		token: body.token,
		expiresAt: body.expires_at ? Date.parse(body.expires_at) : now + 3_000_000
	});
	return { token: body.token };
}

/** The mint without the diagnosis, for callers that only degrade on failure. */
export async function installationToken(
	config: GithubAppConfig,
	installationId: number
): Promise<string | null> {
	return (await mintInstallationToken(config, installationId)).token;
}

/** Drops a cached installation token - used when GitHub reports it revoked. */
export function forgetInstallationToken(installationId: number): void {
	installationTokens.delete(installationId);
}

export interface GithubResponse {
	ok: boolean;
	status: number;
	body: unknown;
}

/**
 * One REST call. Never throws on a GitHub error status - every caller has a
 * meaningful answer for 404/403/409 - but network failures are reported,
 * because a silent null there reads as "no such repo".
 */
export async function githubFetch(
	token: string,
	method: string,
	path: string,
	body?: unknown
): Promise<GithubResponse> {
	try {
		const response = await fetch(`${GITHUB_API}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				accept: 'application/vnd.github+json',
				'x-github-api-version': '2022-11-28',
				// GitHub rejects API requests with no user agent.
				'user-agent': 'cloudflarebase',
				...(body === undefined ? {} : { 'content-type': 'application/json' })
			},
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		const text = await response.text();
		return {
			ok: response.ok,
			status: response.status,
			body: text ? ((JSON.parse(text) as unknown) ?? null) : null
		};
	} catch (cause) {
		console.error('github request failed', method, path, cause);
		Sentry.captureException(cause, { level: 'error', tags: { operation: 'github-fetch' } });
		return { ok: false, status: 502, body: null };
	}
}

// --- HMAC: webhook signatures and install state ----------------------------

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret) as BufferSource,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
	return new Uint8Array(
		await crypto.subtle.sign(
			'HMAC',
			await hmacKey(secret),
			new TextEncoder().encode(message) as BufferSource
		)
	);
}

/** Length-independent, value-independent comparison. */
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let difference = 0;
	for (let index = 0; index < a.length; index += 1) {
		difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
	}
	return difference === 0;
}

/**
 * Verifies `X-Hub-Signature-256` over the RAW body. The body must be the
 * exact bytes GitHub sent - re-serializing parsed JSON changes the digest,
 * so the webhook route reads text() first and parses afterwards.
 */
export async function verifyWebhookSignature(
	secret: string,
	rawBody: string,
	header: string | null
): Promise<boolean> {
	if (!header?.startsWith('sha256=')) return false;
	const digest = [...(await hmac(secret, rawBody))]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
	return timingSafeEqual(`sha256=${digest}`, header);
}

/**
 * Where the signed install state is parked for the return leg.
 *
 * GitHub's INSTALL redirect is not the user-authorization redirect, and it
 * does not reliably echo a `state` parameter back - so the callback reads the
 * query first and falls back to this cookie. Same token, same verification;
 * the cookie only removes the dependency on GitHub round-tripping it.
 */
export const INSTALL_STATE_COOKIE = 'cfbase-gh-install';

export interface InstallState {
	/** Project the operator started the install from. */
	projectId: string;
	/** Console user id - the callback runs as them or not at all. */
	userId: string;
}

/**
 * Signs the install `state` GitHub round-trips back to the callback.
 *
 * This is what binds an `installation_id` to an operator. The id itself
 * arrives on a redirect anyone can craft, so it is only trustworthy while it
 * is accompanied by state we signed, for the user who is making the request,
 * inside the expiry window.
 */
export async function signInstallState(
	config: GithubAppConfig,
	state: InstallState
): Promise<string> {
	const payload = base64url(
		new TextEncoder().encode(JSON.stringify({ ...state, exp: Date.now() + 15 * 60_000 }))
	);
	return `${payload}.${base64url(await hmac(config.webhookSecret, payload))}`;
}

export async function verifyInstallState(
	config: GithubAppConfig,
	token: string | null
): Promise<InstallState | null> {
	const [payload, signature] = token?.split('.') ?? [];
	if (!payload || !signature) return null;
	if (!timingSafeEqual(base64url(await hmac(config.webhookSecret, payload)), signature))
		return null;
	try {
		const decoded = JSON.parse(
			new TextDecoder().decode(decodeBase64(payload.replace(/-/g, '+').replace(/_/g, '/')))
		) as Partial<InstallState & { exp: number }>;
		if (!decoded.projectId || !decoded.userId || !decoded.exp || decoded.exp < Date.now()) {
			return null;
		}
		return { projectId: decoded.projectId, userId: decoded.userId };
	} catch {
		return null;
	}
}

/** Where the operator goes to pick an account and repositories. */
export function installUrl(config: GithubAppConfig, state: string): string {
	return `https://github.com/apps/${encodeURIComponent(config.slug)}/installations/new?state=${encodeURIComponent(state)}`;
}
