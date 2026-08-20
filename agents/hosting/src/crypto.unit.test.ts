import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptValue, encryptValue, importMasterKey } from './crypto';

/**
 * Build secrets are the repo's only encryption at rest, so the contract is
 * pinned end to end: round-trips work, everything else - tampering, a wrong
 * key, a value copied to another row, an unknown format - throws.
 */

const AAD = 'site\0API_KEY';

test('round-trips a value', async () => {
	const key = await importMasterKey('a master key of respectable length!!');
	const stored = await encryptValue(key, 'hunter2', AAD);
	assert.match(stored, /^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
	assert.equal(await decryptValue(key, stored, AAD), 'hunter2');
});

test('the same plaintext never encrypts to the same ciphertext', async () => {
	const key = await importMasterKey('a master key of respectable length!!');
	const first = await encryptValue(key, 'hunter2', AAD);
	const second = await encryptValue(key, 'hunter2', AAD);
	assert.notEqual(first, second); // fresh IV per call
	assert.equal(await decryptValue(key, second, AAD), 'hunter2');
});

test('round-trips edge-case values', async () => {
	const key = await importMasterKey('a master key of respectable length!!');
	for (const value of ['', 'x'.repeat(5000), 'newline\\n literal and unïcøde ✨']) {
		const stored = await encryptValue(key, value, AAD);
		assert.equal(await decryptValue(key, stored, AAD), value);
	}
});

test('a flipped ciphertext bit fails authentication', async () => {
	const key = await importMasterKey('a master key of respectable length!!');
	const stored = await encryptValue(key, 'hunter2', AAD);
	const tampered = stored.slice(0, -1) + (stored.endsWith('A') ? 'B' : 'A');
	await assert.rejects(decryptValue(key, tampered, AAD));
});

test('a ciphertext copied to another row fails authentication', async () => {
	const key = await importMasterKey('a master key of respectable length!!');
	const stored = await encryptValue(key, 'hunter2', AAD);
	await assert.rejects(decryptValue(key, stored, 'site\0OTHER_NAME'));
	await assert.rejects(decryptValue(key, stored, 'other-app\0API_KEY'));
});

test('the wrong key fails authentication', async () => {
	const key = await importMasterKey('a master key of respectable length!!');
	const other = await importMasterKey('a different master key entirely!!!!!');
	const stored = await encryptValue(key, 'hunter2', AAD);
	await assert.rejects(decryptValue(other, stored, AAD));
});

test('unknown versions and malformed inputs are refused, not guessed at', async () => {
	const key = await importMasterKey('a master key of respectable length!!');
	const stored = await encryptValue(key, 'hunter2', AAD);
	const [, iv, ciphertext] = stored.split(':');
	for (const bad of [
		`v9:${iv}:${ciphertext}`, // future version
		`${stored}:extra`, // trailing segment
		'v1:only-two',
		'v1',
		'',
		'plaintext-that-was-never-encrypted',
	]) {
		await assert.rejects(decryptValue(key, bad, AAD), /unsupported ciphertext|error/i);
	}
});
