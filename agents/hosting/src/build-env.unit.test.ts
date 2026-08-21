import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeBuildEnv } from './build-env';

test('runtime env reaches the build, and build-specific values win', () => {
	const merged = mergeBuildEnv(
		{
			vars: { PUBLIC_API_URL: 'https://api.example', REGION: 'weur' },
			secrets: { DATABASE_URL: 'postgres://runtime' },
		},
		{
			vars: { PUBLIC_API_URL: 'https://staging-api.example' },
			secrets: { NPM_TOKEN: 'npm_x' },
		},
	);
	// The build-specific override wins; everything else flows through.
	assert.deepEqual(merged.vars, {
		PUBLIC_API_URL: 'https://staging-api.example',
		REGION: 'weur',
	});
	assert.deepEqual(merged.secrets, {
		DATABASE_URL: 'postgres://runtime',
		NPM_TOKEN: 'npm_x',
	});
});

test('empty stores merge to empty, not to errors', () => {
	assert.deepEqual(mergeBuildEnv({ vars: {}, secrets: {} }, { vars: {}, secrets: {} }), {
		vars: {},
		secrets: {},
	});
});
