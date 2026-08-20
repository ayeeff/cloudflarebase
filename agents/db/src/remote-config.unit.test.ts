import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	isPlatformShard,
	MAX_REMOTE_CONFIG_VALUE_BYTES,
	remoteConfigKeySchema,
	remoteConfigPending,
	remoteConfigValueIssue,
	REMOTE_CONFIG_COLUMNS,
	REMOTE_CONFIG_TABLE,
	tableColumnsSchema,
} from './schemas';

/**
 * Remote Config's pure parts: the value/type check, the pending rule the whole
 * draft model hangs off, and the platform-shard reservation.
 *
 * The declared columns are parsed here too. They are the one place a typo would
 * not show up until a project tried to provision the table on a deployed agent
 * - by which point the failure is a 500 in someone else's console.
 */

test('the declared columns are a valid table schema', () => {
	const columns = tableColumnsSchema.parse(REMOTE_CONFIG_COLUMNS);
	assert.deepEqual(
		columns.map((column) => column.name),
		[
			'value_type',
			'draft_value',
			'published_value',
			'draft_conditions',
			'published_conditions',
			'state',
			'description',
			'updated_by',
		],
	);
	// Every value and rule column must be json: a config value is any JSON, and
	// a scalar column would quietly reject an object default.
	for (const name of [
		'draft_value',
		'published_value',
		'draft_conditions',
		'published_conditions',
	]) {
		assert.equal(columns.find((column) => column.name === name)?.type, 'json', name);
	}
	// The draft/published pairs must be NULLABLE, which is what lets the DDL
	// planner add them to a table an earlier version already created - a project
	// provisioned before targeting existed gains them on next touch rather than
	// needing a migration nobody can run.
	for (const name of ['draft_conditions', 'published_conditions']) {
		assert.equal(columns.find((column) => column.name === name)?.nullable, true, name);
	}
});

test('values are checked against their declared type', () => {
	assert.equal(remoteConfigValueIssue('boolean', true), null);
	assert.equal(remoteConfigValueIssue('number', 25), null);
	assert.equal(remoteConfigValueIssue('string', 'eur'), null);
	assert.equal(remoteConfigValueIssue('json', { variant: 'b' }), null);
	assert.equal(remoteConfigValueIssue('json', [1, 2]), null);
	// null is a legitimate json value and the reason json is not just "object".
	assert.equal(remoteConfigValueIssue('json', null), null);

	assert.match(remoteConfigValueIssue('boolean', 'yes') ?? '', /boolean/);
	assert.match(remoteConfigValueIssue('number', '25') ?? '', /number/);
	assert.match(remoteConfigValueIssue('string', 25) ?? '', /string/);
	// A scalar in a json parameter is a mistake worth naming: the operator
	// wanted one of the three scalar types.
	assert.match(remoteConfigValueIssue('json', 'plain') ?? '', /scalar types/);
	assert.match(remoteConfigValueIssue('string', undefined) ?? '', /required/);
	// NaN and Infinity do not survive JSON, so they are not numbers here.
	assert.match(remoteConfigValueIssue('number', Number.NaN) ?? '', /number/);
	assert.match(remoteConfigValueIssue('number', Number.POSITIVE_INFINITY) ?? '', /number/);
});

test('a value too large to ship on every app start is refused', () => {
	const huge = 'x'.repeat(MAX_REMOTE_CONFIG_VALUE_BYTES + 1);
	assert.match(remoteConfigValueIssue('string', huge) ?? '', /limited to/);
	assert.equal(remoteConfigValueIssue('string', 'x'.repeat(64)), null);
});

test('keys are client identifiers, so they read like one', () => {
	for (const key of ['checkoutV2', 'max_upload_mb', 'a', 'feature-flag']) {
		assert.equal(remoteConfigKeySchema.safeParse(key).success, true, key);
	}
	for (const key of ['9lives', '_private', 'has space', 'trailing/slash', '', 'x'.repeat(65)]) {
		assert.equal(remoteConfigKeySchema.safeParse(key).success, false, key);
	}
});

test('pending is what the publish button counts', () => {
	// Never published: pending whatever the values say.
	assert.equal(
		remoteConfigPending({ state: 'draft', draftValue: false, publishedValue: null }),
		true,
	);
	// Marked for removal: pending, because the removal has not happened yet.
	assert.equal(remoteConfigPending({ state: 'deleting', draftValue: 1, publishedValue: 1 }), true);
	// Live and unchanged.
	assert.equal(
		remoteConfigPending({ state: 'published', draftValue: 1, publishedValue: 1 }),
		false,
	);
	// Live and edited.
	assert.equal(remoteConfigPending({ state: 'published', draftValue: 2, publishedValue: 1 }), true);
	// Structural equality, not identity - two equal objects are not a change,
	// or every page load would report edits nobody made.
	assert.equal(
		remoteConfigPending({
			state: 'published',
			draftValue: { a: [1, 2] },
			publishedValue: { a: [1, 2] },
		}),
		false,
	);
	// null and undefined both mean "no value" and must not read as a change.
	assert.equal(
		remoteConfigPending({ state: 'published', draftValue: null, publishedValue: undefined }),
		false,
	);
});

test('the platform namespace is a prefix, so the next feature needs no new rule', () => {
	assert.equal(isPlatformShard(REMOTE_CONFIG_TABLE), true);
	assert.equal(isPlatformShard('cfb_anything_later'), true);
	// An operator's own tables are untouched, including ones that merely start
	// with the letters.
	assert.equal(isPlatformShard('cfb'), false);
	assert.equal(isPlatformShard('cfbase_notes'), false);
	assert.equal(isPlatformShard('remote_config'), false);
	assert.equal(isPlatformShard('todos'), false);
});
