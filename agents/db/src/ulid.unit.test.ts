import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ulid } from './ulid';
import { documentIdSchema } from './schemas';

/**
 * ULIDs replace UUIDv4 for auto-generated ids so that id order - the default
 * for exports, cursor pages, and the dashboard browser - is chronological.
 * Sortability is the whole point, so that is what these pin.
 */

test('ulid: 26 Crockford base32 chars that documentIdSchema accepts', () => {
	const id = ulid();
	assert.equal(id.length, 26);
	assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
	assert.equal(documentIdSchema.safeParse(id).success, true);
});

test('ulid: later timestamps sort after earlier ones, lexicographically', () => {
	const early = ulid(new Date('2020-01-01T00:00:00Z').getTime());
	const mid = ulid(new Date('2026-07-31T00:00:00Z').getTime());
	const late = ulid(new Date('2031-12-31T23:59:59Z').getTime());
	assert.deepEqual([late, early, mid].sort(), [early, mid, late]);
	// The timestamp lives in the first 10 chars, so equal-ms ids share it.
	assert.equal(ulid(1_700_000_000_000).slice(0, 10), ulid(1_700_000_000_000).slice(0, 10));
});

test('ulid: ids minted in the same millisecond stay ordered and unique', () => {
	const now = 1_700_000_000_000;
	const ids = Array.from({ length: 50 }, () => ulid(now));
	assert.equal(new Set(ids).size, ids.length);
	// Monotonic within a tick: the random half increments instead of
	// re-rolling, so a burst of writes keeps creation order.
	assert.deepEqual([...ids].sort(), ids);
});
