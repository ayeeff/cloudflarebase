import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectedWorkflowYaml, deployWorkflowYaml } from './hosting-workflow';

const base = { origin: 'https://cloudflarebase.com', projectId: 'demo-app', appName: 'landmatch' };

test('the default connected workflow matches the pre-preset shape', () => {
	const yaml = connectedWorkflowYaml(base);
	assert.match(yaml, /npm ci --prefer-offline/);
	assert.match(yaml, /npm run build --if-present/);
	// The default build is guarded: `npm run` without a package.json is a
	// hard error, not a skip.
	assert.match(yaml, /- name: Build\n {8}if: hashFiles\('package\.json'\) != ''/);
	assert.doesNotMatch(yaml, /CLOUDFLAREBASE_ASSETS/);
	assert.match(yaml, /id-token: write/);
});

test('a preset command replaces the default and drops its package.json guard', () => {
	const yaml = connectedWorkflowYaml({ ...base, buildCommand: 'hugo --minify' });
	assert.match(yaml, /\n {10}hugo --minify\n/);
	assert.doesNotMatch(yaml, /npm run build --if-present/);
	assert.doesNotMatch(yaml, /- name: Build\n {8}if:/);
});

test('the output directory travels as CLOUDFLAREBASE_ASSETS', () => {
	const yaml = connectedWorkflowYaml({ ...base, outputDir: '.output/public' });
	assert.match(yaml, /\n {10}CLOUDFLAREBASE_ASSETS: \.output\/public\n/);
});

test('pnpm repositories install with pnpm and skip the setup-node cache', () => {
	const yaml = connectedWorkflowYaml({
		...base,
		packageManager: 'pnpm',
		buildCommand: 'pnpm run build'
	});
	assert.match(yaml, /pnpm install --frozen-lockfile \|\| pnpm install/);
	assert.match(yaml, /cache: ''/);
	assert.match(yaml, /corepack enable/);
	assert.doesNotMatch(yaml, /npm ci/);
});

test('yarn keeps the cache and tries immutable before frozen-lockfile', () => {
	const yaml = connectedWorkflowYaml({ ...base, packageManager: 'yarn' });
	assert.match(yaml, /yarn install --immutable \|\| yarn install --frozen-lockfile/);
	assert.match(yaml, /hashFiles\('yarn\.lock'\)/);
});

test('every step that can hang carries its own timeout', () => {
	for (const yaml of [connectedWorkflowYaml(base), deployWorkflowYaml()]) {
		const buildTimeouts = yaml.match(/timeout-minutes: 10/g) ?? [];
		const deployTimeouts = yaml.match(/timeout-minutes: 5/g) ?? [];
		assert.equal(buildTimeouts.length, 1, 'the build step is bounded');
		assert.equal(deployTimeouts.length, 1, 'the deploy step is bounded');
	}
});

test('a root directory scopes every step and re-points the hashFiles guards', () => {
	const yaml = connectedWorkflowYaml({ ...base, rootDir: 'sites/blabla' });
	// hashFiles resolves from the workspace root regardless of
	// working-directory, so every guard must carry the prefix.
	assert.match(yaml, /hashFiles\('sites\/blabla\/package\.json'\)/);
	assert.doesNotMatch(yaml, /hashFiles\('package\.json'\)/);
	assert.match(
		yaml,
		/hashFiles\('sites\/blabla\/package-lock\.json', 'sites\/blabla\/npm-shrinkwrap\.json'\)/
	);
	assert.match(yaml, /cache-dependency-path: sites\/blabla\/package-lock\.json/);
	// Install, build, and deploy all run in the subdirectory.
	const wd = yaml.match(/working-directory: sites\/blabla/g) ?? [];
	assert.equal(wd.length, 3);
});

test('no root directory means no working-directory lines at all', () => {
	const yaml = connectedWorkflowYaml(base);
	assert.doesNotMatch(yaml, /working-directory/);
	assert.doesNotMatch(yaml, /cache-dependency-path/);
});

test('YAML stays tab-free and the run blocks stay indented', () => {
	const yaml = connectedWorkflowYaml({
		...base,
		packageManager: 'bun',
		buildCommand: 'bun run build && bun run postbuild',
		outputDir: 'dist',
		rootDir: 'apps/web'
	});
	assert.doesNotMatch(yaml, /\t/);
	// Every non-empty line inside the file is indented or a top-level key.
	for (const line of yaml.split('\n')) {
		if (!line) continue;
		assert.ok(/^( |#|name:|on:|concurrency:|jobs:)/.test(line), `unexpected line: ${line}`);
	}
});
