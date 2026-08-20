import assert from 'node:assert/strict';
import test from 'node:test';
import { deployVars, wrapEntry } from './cloudflare';

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
