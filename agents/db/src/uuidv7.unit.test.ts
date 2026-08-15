import assert from 'node:assert/strict';
import test from 'node:test';
import { v7 as uuidv7 } from 'uuid';

/**
 * UUIDv7 (the `uuid` package) replaces random UUIDs (and the earlier
 * hand-written ULIDs) for auto-generated ids so that id order - the default
 * for exports, cursor pages, and the dashboard browser - is chronological.
 * These pin the invariants the storage layer leans on, not the library's
 * internals: RFC 9562 shape inside documentIdSchema's charset, and
 * lexicographic sortability across and within milliseconds.
 */

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('uuidv7: RFC 9562 format that documentIdSchema accepts', () => {
	const id = uuidv7();
	assert.match(id, UUID_V7_PATTERN);
	assert.match(id, /^[A-Za-z0-9_-]{1,64}$/);
});

test('uuidv7: later timestamps sort after earlier ones, lexicographically', () => {
	const early = uuidv7({ msecs: new Date('2020-01-01T00:00:00Z').getTime() });
	const mid = uuidv7({ msecs: new Date('2026-07-31T00:00:00Z').getTime() });
	const late = uuidv7({ msecs: new Date('2031-12-31T23:59:59Z').getTime() });
	assert.ok(early < mid);
	assert.ok(mid < late);
});

test('uuidv7: ids minted in the same millisecond stay ordered and unique', () => {
	// Minted the way the agent mints them - `v7()` with no arguments. Passing
	// an explicit `msecs` would prove nothing about storage: that path skips
	// the library's monotonic sequence counter and randomizes the sub-
	// millisecond bits per call, so the ids come back out of order by design.
	// A tight loop lands well inside one millisecond anyway.
	const ids = Array.from({ length: 200 }, () => uuidv7());
	assert.equal(new Set(ids).size, ids.length);
	assert.deepEqual([...ids].sort(), ids);
});
