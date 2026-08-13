import assert from 'node:assert/strict';
import test from 'node:test';
import { ArchiveTooLarge, gunzip, parseTar, toAssetPaths } from './tar.js';
import { TARBALL_BASE64 } from './tar.fixture.js';

/**
 * The tar reader is fed attacker-controlled input from a GitHub tarball, so
 * the fixture is a REAL archive from another tar implementation rather than
 * one written by these tests.
 */

function fixtureStream(): ReadableStream<Uint8Array> {
	const bytes = Uint8Array.from(Buffer.from(TARBALL_BASE64, 'base64'));
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

async function fixtureEntries() {
	return parseTar(await gunzip(fixtureStream(), 16 * 1024 * 1024), 1000);
}

test('parses every regular file out of a real tarball', async () => {
	const names = (await fixtureEntries()).map((entry) => entry.name).sort();
	assert.deepEqual(
		names,
		[
			'owner-repo-abc123def/.github/workflows/ci.yml',
			'owner-repo-abc123def/.gitignore',
			'owner-repo-abc123def/README.md',
			'owner-repo-abc123def/dist/app.css',
			'owner-repo-abc123def/dist/index.html',
			'owner-repo-abc123def/dist/assets/a-very-long-directory-name-to-push-the-header-past-one-hundred-characters/nested-further-still/deep.js',
			'owner-repo-abc123def/node_modules/pkg/index.js',
		].sort(),
	);
});

test('reads a path too long for the tar name field', async () => {
	// The 100-byte name field cannot hold this, so it arrives as a PAX record.
	// Getting it wrong silently truncates paths rather than failing loudly.
	const entries = await fixtureEntries();
	const deep = entries.find((entry) => entry.name.endsWith('deep.js'));
	assert.ok(deep, 'the long-path entry survived');
	assert.ok(deep.name.length > 100);
	assert.equal(new TextDecoder().decode(deep.bytes).trim(), 'console.log(1)');
});

test('directories and file contents come through intact', async () => {
	const entries = await fixtureEntries();
	const index = entries.find((entry) => entry.name.endsWith('dist/index.html'));
	assert.ok(index);
	assert.equal(new TextDecoder().decode(index.bytes).trim(), '<h1>hello</h1>');
});

test('assets are rooted at the selected directory', async () => {
	const assets = toAssetPaths(await fixtureEntries(), 'dist');
	const paths = assets.map((asset) => asset.path).sort();
	// The wrapper directory AND the `dist` prefix are both stripped.
	assert.deepEqual(paths, [
		'/app.css',
		'/assets/a-very-long-directory-name-to-push-the-header-past-one-hundred-characters/nested-further-still/deep.js',
		'/index.html',
	]);
});

test('repository furniture is never published', async () => {
	// Deploying from the repo root must not ship .github, .gitignore, or a
	// committed node_modules - at best noise, at worst a leak.
	const paths = toAssetPaths(await fixtureEntries(), '').map((asset) => asset.path);
	assert.ok(paths.includes('/README.md'));
	assert.ok(paths.includes('/dist/index.html'));
	assert.ok(!paths.some((path) => path.includes('.github')));
	assert.ok(!paths.some((path) => path.includes('.gitignore')));
	assert.ok(!paths.some((path) => path.includes('node_modules')));
});

test('a missing directory selects nothing rather than everything', async () => {
	// The failure that matters: falling back to the repo root here would
	// publish the whole source tree on a typo'd assets directory.
	assert.deepEqual(toAssetPaths(await fixtureEntries(), 'build'), []);
});

test('decompression stops at the byte ceiling', async () => {
	await assert.rejects(() => gunzip(fixtureStream(), 64), ArchiveTooLarge);
});

test('the file-count ceiling is enforced', async () => {
	const buffer = await gunzip(fixtureStream(), 16 * 1024 * 1024);
	assert.throws(() => parseTar(buffer, 2), /more than 2 files/);
});
