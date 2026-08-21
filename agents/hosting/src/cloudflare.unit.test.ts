import assert from 'node:assert/strict';
import test from 'node:test';
import { deleteScriptSecret, deployVars, patchScriptVars, wrapEntry } from './cloudflare';

/**
 * The shim entry only matters against a REAL dispatch namespace (untrusted
 * mode is where `caches.default` is forbidden), and the e2e stack runs on the
 * stub, which uploads nothing. So the shape of what we upload is pinned here.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const module = (name: string, source = 'export default {};') => ({
	name,
	bytes: encoder.encode(source),
});
const sourceOf = (modules: { name: string; bytes: Uint8Array }[], name: string) =>
	decoder.decode(modules.find((entry) => entry.name === name)!.bytes);

test('an assets-only deploy is left alone', () => {
	const result = wrapEntry([], undefined);
	assert.deepEqual(result.modules, []);
	assert.equal(result.mainModule, undefined);
});

test('the customer entry is entered through the shim', () => {
	const result = wrapEntry([module('_worker.js')], '_worker.js');

	assert.equal(result.mainModule, '__cfbase_entry.js');
	assert.deepEqual(
		result.modules.map((entry) => entry.name),
		['_worker.js', '__cfbase_runtime.js', '__cfbase_entry.js'],
	);

	const entry = sourceOf(result.modules, '__cfbase_entry.js');
	// Import order is the whole mechanism: the shim must be evaluated before
	// the customer bundle's module body captures `caches.default`.
	assert.ok(entry.indexOf('__cfbase_runtime.js') < entry.indexOf('_worker.js'));
	// Named exports (Durable Object classes) survive the wrap.
	assert.match(entry, /export \* from "\.\/_worker\.js"/);
	assert.match(entry, /export default entry\.default/);

	const shim = sourceOf(result.modules, '__cfbase_runtime.js');
	assert.match(shim, /caches\?\.default/);
	assert.match(shim, /cache\.match = async \(\) => undefined/);
});

test('a nested entry keeps resolving from the generated root entry', () => {
	const result = wrapEntry([module('dist/index.js'), module('dist/chunk.js')], 'dist/index.js');
	assert.match(sourceOf(result.modules, '__cfbase_entry.js'), /from "\.\/dist\/index\.js"/);
});

test('customer modules of the generated names are never shadowed', () => {
	const result = wrapEntry(
		[module('_worker.js'), module('__cfbase_runtime.js'), module('__cfbase_entry.js')],
		'_worker.js',
	);

	assert.equal(result.mainModule, '__cfbase_entry_2.js');
	// The customer's own files are uploaded untouched.
	assert.equal(sourceOf(result.modules, '__cfbase_runtime.js'), 'export default {};');
	assert.match(sourceOf(result.modules, '__cfbase_entry_2.js'), /__cfbase_runtime_2\.js/);
});

test('deployVars: the platform is authoritative about which project an app is', () => {
	const vars = deployVars({ API_BASE: 'https://api.example' }, 'acme', 'https://console.example');
	// The customer's own vars survive untouched.
	assert.equal(vars.API_BASE, 'https://api.example');
	// And the app is born knowing its project: these are exactly the names
	// createDbAdmin()/createStorageAdmin() resolve from, so a hosted Worker
	// self-configures with no setup step.
	assert.equal(vars.CLOUDFLAREBASE_PROJECT, 'acme');
	assert.equal(vars.CLOUDFLAREBASE_URL, 'https://console.example');
	// Kept for apps already deployed against it.
	assert.equal(vars.PROJECT_ID, 'acme');
});

test('deployVars: an app cannot point itself at another project', () => {
	// Which project an app belongs to is the platform's fact, not a value the
	// app gets to disagree with - otherwise editing a config file would reach
	// into another tenant's data plane.
	const vars = deployVars(
		{ CLOUDFLAREBASE_PROJECT: 'someone-else', CLOUDFLAREBASE_URL: 'https://evil.example' },
		'acme',
		'https://console.example',
	);
	assert.equal(vars.CLOUDFLAREBASE_PROJECT, 'acme');
	assert.equal(vars.CLOUDFLAREBASE_URL, 'https://console.example');
});

/**
 * The settings PATCH shapes are pinned here for the same reason as the shim:
 * they only run against a REAL dispatch namespace, which the e2e stub never
 * dials. A captured fetch is the whole harness.
 */

const API = { accountId: 'acct', apiToken: 'tok', namespace: 'ns' };

async function withFetchCapture<T>(
	response: Response,
	run: () => Promise<T>,
): Promise<{ url: string; init: RequestInit }> {
	const original = globalThis.fetch;
	let captured: { url: string; init: RequestInit } | undefined;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		captured = { url: String(input), init: init ?? {} };
		return response;
	}) as typeof fetch;
	try {
		await run();
	} finally {
		globalThis.fetch = original;
	}
	assert.ok(captured, 'fetch was never called');
	return captured!;
}

const ok = () => new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });

test('patchScriptVars replaces the plain_text set and keeps everything else', async () => {
	const { url, init } = await withFetchCapture(ok(), () =>
		patchScriptVars(API, 'site', { A: '1', B: '2' }),
	);
	assert.equal(
		url,
		'https://api.cloudflare.com/client/v4/accounts/acct/workers/dispatch/namespaces/ns/scripts/site/settings',
	);
	assert.equal(init.method, 'PATCH');
	const part = (init.body as FormData).get('settings') as Blob;
	const settings = JSON.parse(await part.text()) as {
		bindings: { type: string; name: string; text: string }[];
		keep_bindings: string[];
		keep_assets: boolean;
	};
	assert.deepEqual(settings.bindings, [
		{ type: 'plain_text', name: 'A', text: '1' },
		{ type: 'plain_text', name: 'B', text: '2' },
	]);
	// NOT 'plain_text': replacing the whole set is how a deleted var actually
	// disappears from the live script.
	assert.deepEqual(settings.keep_bindings, ['secret_text', 'assets']);
	assert.equal(settings.keep_assets, true);
});

test('deleteScriptSecret dials the per-script secret and tolerates 404', async () => {
	const { url, init } = await withFetchCapture(ok(), () =>
		deleteScriptSecret(API, 'site', 'API_KEY'),
	);
	assert.equal(
		url,
		'https://api.cloudflare.com/client/v4/accounts/acct/workers/dispatch/namespaces/ns/scripts/site/secrets/API_KEY',
	);
	assert.equal(init.method, 'DELETE');

	// Already gone is not an error - the row deletion must proceed.
	await withFetchCapture(new Response('', { status: 404 }), () =>
		deleteScriptSecret(API, 'site', 'API_KEY'),
	);

	// Anything else is.
	const original = globalThis.fetch;
	globalThis.fetch = (async () => new Response('', { status: 500 })) as typeof fetch;
	try {
		await assert.rejects(deleteScriptSecret(API, 'site', 'API_KEY'), /HTTP 500/);
	} finally {
		globalThis.fetch = original;
	}
});
