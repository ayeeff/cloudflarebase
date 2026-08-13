/**
 * Cloudflare REST driver for Workers for Platforms uploads. Kept apart from
 * the agent so the orchestration reads as the three documented steps: asset
 * upload session -> wanted buckets -> script put.
 *
 * Asset manifest hashes are salted with the project id (SHA-256 over
 * `<projectId>\0<bytes>`, truncated to the API's 32 hex chars): identical
 * assets are deduplicated within a namespace BY HASH, so unsalted hashes
 * would let one tenant probe another's content. The salt scopes dedup to the
 * project, which is the correctness/privacy trade the design doc picks.
 */

export interface CfApi {
	accountId: string;
	apiToken: string;
	namespace: string;
}

export interface AssetFile {
	/** URL path the asset serves at, always starting with `/`. */
	path: string;
	bytes: Uint8Array;
	contentType: string;
}

export interface ModuleFile {
	/** Module file name (`index.js`); also its part name in the upload. */
	name: string;
	bytes: Uint8Array;
}

export interface PutScriptOptions {
	projectId: string;
	appName: string;
	/** Entry module name; undefined = assets-only Worker. */
	mainModule?: string;
	modules: ModuleFile[];
	compatibilityDate: string;
	compatibilityFlags: string[];
	/** Completion token from the asset session; undefined = no assets. */
	assetsJwt?: string;
	notFoundHandling?: 'single-page-application' | '404-page' | 'none';
	/** Injected beside the user's own vars so the SDK works out of the box. */
	vars: Record<string, string>;
}

const API_BASE = 'https://api.cloudflare.com/client/v4';

interface CfEnvelope<T> {
	success: boolean;
	errors?: { code?: number; message?: string }[];
	result?: T;
}

async function cfFetch<T>(api: CfApi, path: string, init: RequestInit = {}): Promise<T> {
	const response = await fetch(`${API_BASE}/accounts/${api.accountId}${path}`, {
		...init,
		headers: {
			authorization: `Bearer ${api.apiToken}`,
			...(init.headers ?? {}),
		},
	});
	const body = (await response.json().catch(() => null)) as CfEnvelope<T> | null;
	if (!response.ok || !body?.success) {
		const detail =
			body?.errors?.map((error) => `${error.code ?? '?'}: ${error.message ?? '?'}`).join('; ') ??
			`HTTP ${response.status}`;
		throw new Error(`Cloudflare API ${path} failed - ${detail}`);
	}
	return body.result as T;
}

async function saltedHash(projectId: string, bytes: Uint8Array): Promise<string> {
	const salt = new TextEncoder().encode(`${projectId}\0`);
	const input = new Uint8Array(salt.length + bytes.length);
	input.set(salt, 0);
	input.set(bytes, salt.length);
	const digest = await crypto.subtle.digest('SHA-256', input);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
		.slice(0, 32);
}

function toBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

/**
 * Runs the asset upload session for a script: manifest -> wanted buckets ->
 * base64 uploads -> completion token. Returns undefined when there are no
 * assets at all. When every asset is already known to the namespace the
 * session's own jwt IS the completion token.
 */
export async function uploadAssets(
	api: CfApi,
	scriptName: string,
	projectId: string,
	files: AssetFile[],
): Promise<string | undefined> {
	if (!files.length) return undefined;

	const byHash = new Map<string, AssetFile>();
	const manifest: Record<string, { hash: string; size: number }> = {};
	for (const file of files) {
		const hash = await saltedHash(projectId, file.bytes);
		byHash.set(hash, file);
		manifest[file.path] = { hash, size: file.bytes.length };
	}

	const session = await cfFetch<{ jwt: string; buckets?: string[][] }>(
		api,
		`/workers/dispatch/namespaces/${api.namespace}/scripts/${scriptName}/assets-upload-session`,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ manifest }),
		},
	);

	const buckets = session.buckets ?? [];
	if (!buckets.length) return session.jwt;

	let completion: string | undefined;
	for (const bucket of buckets) {
		const form = new FormData();
		for (const hash of bucket) {
			const file = byHash.get(hash);
			if (!file) throw new Error(`Cloudflare asked for an unknown asset hash ${hash}`);
			form.append(hash, new Blob([toBase64(file.bytes)], { type: file.contentType }), hash);
		}
		const response = await fetch(
			`${API_BASE}/accounts/${api.accountId}/workers/assets/upload?base64=true`,
			{
				method: 'POST',
				headers: { authorization: `Bearer ${session.jwt}` },
				body: form,
			},
		);
		const body = (await response.json().catch(() => null)) as CfEnvelope<{
			jwt?: string;
		}> | null;
		if (!response.ok || !body?.success) {
			throw new Error(`asset upload failed - HTTP ${response.status}`);
		}
		if (body.result?.jwt) completion = body.result.jwt;
	}

	if (!completion) throw new Error('asset upload finished without a completion token');
	return completion;
}

/** Uploads the script to the dispatch namespace. The script name IS the
 * subdomain; the `pid-` tag is what erase deletes by. */
export async function putScript(
	api: CfApi,
	scriptName: string,
	options: PutScriptOptions,
): Promise<void> {
	const bindings: Record<string, string>[] = Object.entries(options.vars).map(([name, text]) => ({
		type: 'plain_text',
		name,
		text,
	}));
	if (options.assetsJwt && options.mainModule) {
		bindings.push({ type: 'assets', name: 'ASSETS' });
	}

	const metadata: Record<string, unknown> = {
		compatibility_date: options.compatibilityDate,
		compatibility_flags: options.compatibilityFlags,
		bindings,
		// `pid-` rather than `project:` - the scripts-by-tag filter grammar is
		// `?tags=<tag>:yes`, so a colon inside a tag collides with it.
		tags: [`pid-${options.projectId}`, `app-${options.appName}`],
		// Secrets are PATCHed separately; redeploys must never drop them.
		keep_bindings: ['secret_text'],
	};
	if (options.mainModule) metadata.main_module = options.mainModule;
	if (options.assetsJwt) {
		metadata.assets = {
			jwt: options.assetsJwt,
			config: {
				html_handling: 'auto-trailing-slash',
				not_found_handling:
					options.notFoundHandling ?? (options.mainModule ? 'none' : 'single-page-application'),
			},
		};
	}

	const form = new FormData();
	form.append(
		'metadata',
		new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
		'metadata',
	);
	for (const module of options.modules) {
		form.append(
			module.name,
			new Blob([module.bytes], { type: 'application/javascript+module' }),
			module.name,
		);
	}

	await cfFetch(api, `/workers/dispatch/namespaces/${api.namespace}/scripts/${scriptName}`, {
		method: 'PUT',
		body: form,
	});
}

/** Bulk-delete every script carrying the project tag (the erase fan-in). */
export async function deleteScriptsByTag(api: CfApi, tag: string): Promise<void> {
	const response = await fetch(
		`${API_BASE}/accounts/${api.accountId}/workers/dispatch/namespaces/${api.namespace}/scripts?tags=${encodeURIComponent(`${tag}:yes`)}`,
		{
			method: 'DELETE',
			headers: { authorization: `Bearer ${api.apiToken}` },
		},
	);
	// 404 means nothing carried the tag - erase is idempotent.
	if (!response.ok && response.status !== 404) {
		throw new Error(`deleting scripts by tag failed - HTTP ${response.status}`);
	}
}

/** Sets one secret on a deployed script without touching anything else. */
export async function patchScriptSecret(
	api: CfApi,
	scriptName: string,
	name: string,
	value: string,
): Promise<void> {
	const form = new FormData();
	form.append(
		'settings',
		new Blob(
			[
				JSON.stringify({
					bindings: [{ type: 'secret_text', name, text: value }],
					// Keep everything the deploy put there - this call only adds.
					keep_bindings: ['plain_text', 'secret_text', 'assets'],
					keep_assets: true,
				}),
			],
			{ type: 'application/json' },
		),
		'settings',
	);
	await cfFetch(
		api,
		`/workers/dispatch/namespaces/${api.namespace}/scripts/${scriptName}/settings`,
		{
			method: 'PATCH',
			body: form,
		},
	);
}
