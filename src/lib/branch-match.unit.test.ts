import assert from 'node:assert/strict';
import test from 'node:test';
import { branchFilterSchema, branchIsIgnored, parseIgnoredBranches } from './branch-match';

/**
 * Three places enforce ignored branches (webhook skip, workflow
 * branches-ignore, OIDC grant refusal) and all three call THIS matcher, so
 * its edges are pinned here once.
 */

test('exact names match exactly', () => {
	assert.equal(branchIsIgnored(['tmp'], 'tmp'), true);
	assert.equal(branchIsIgnored(['tmp'], 'tmp2'), false);
	assert.equal(branchIsIgnored(['tmp'], 'a/tmp'), false);
	assert.equal(branchIsIgnored([], 'anything'), false);
});

test('a * glob matches any run of characters, across slashes', () => {
	assert.equal(branchIsIgnored(['renovate/*'], 'renovate/react-19'), true);
	assert.equal(branchIsIgnored(['renovate/*'], 'renovate/deep/nesting'), true);
	assert.equal(branchIsIgnored(['renovate/*'], 'renovate'), false);
	assert.equal(branchIsIgnored(['*-wip'], 'feature-wip'), true);
	assert.equal(branchIsIgnored(['*'], 'anything/at-all'), true);
});

test('regex metacharacters in a filter are literal, not syntax', () => {
	assert.equal(branchIsIgnored(['v1.0'], 'v1.0'), true);
	// An unescaped dot would let `v1.0` match `v1x0`.
	assert.equal(branchIsIgnored(['v1.0'], 'v1x0'), false);
	assert.equal(branchIsIgnored(['a+b'], 'a+b'), true);
	assert.equal(branchIsIgnored(['a+b'], 'aab'), false);
});

test('parseIgnoredBranches tolerates every malformed column value', () => {
	assert.deepEqual(parseIgnoredBranches(null), []);
	assert.deepEqual(parseIgnoredBranches(''), []);
	assert.deepEqual(parseIgnoredBranches('not json'), []);
	assert.deepEqual(parseIgnoredBranches('{"a":1}'), []);
	assert.deepEqual(parseIgnoredBranches('[1, "keep", null]'), ['keep']);
	assert.deepEqual(parseIgnoredBranches('["tmp","renovate/*"]'), ['tmp', 'renovate/*']);
});

test('the filter schema refuses what YAML embedding cannot carry', () => {
	assert.equal(branchFilterSchema.safeParse('renovate/*').success, true);
	assert.equal(branchFilterSchema.safeParse('release-1.2_x').success, true);
	for (const bad of ['', "quo'te", 'two words', 'new\nline', 'tick`s', '$(sub)']) {
		assert.equal(branchFilterSchema.safeParse(bad).success, false, bad);
	}
});
