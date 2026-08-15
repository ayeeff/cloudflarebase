import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	detectFramework,
	detectPackageManager,
	hasWranglerConfig,
	wranglerConfigJsonc,
	type RepoFacts
} from './frameworks';

/** A facts object with sane defaults; tests override what they assert on. */
function facts(partial: Partial<RepoFacts>): RepoFacts {
	return {
		dependencies: {},
		scripts: { build: 'vite build' },
		packageManager: 'npm',
		rootEntries: ['package.json', 'src'],
		hasWranglerConfig: false,
		nextConfigSource: null,
		...partial
	};
}

test('package manager: lockfile wins over the packageManager field', () => {
	assert.equal(detectPackageManager(['pnpm-lock.yaml'], 'yarn@4.0.0'), 'pnpm');
	assert.equal(detectPackageManager(['yarn.lock'], null), 'yarn');
	assert.equal(detectPackageManager(['bun.lockb'], null), 'bun');
	assert.equal(detectPackageManager(['bun.lock'], null), 'bun');
	assert.equal(detectPackageManager(['package-lock.json'], 'pnpm@9.0.0'), 'npm');
	assert.equal(detectPackageManager([], 'pnpm@9.0.0'), 'pnpm');
	assert.equal(detectPackageManager([], null), 'npm');
});

test('wrangler config: any of the three spellings', () => {
	assert.equal(hasWranglerConfig(['wrangler.jsonc']), true);
	assert.equal(hasWranglerConfig(['wrangler.toml']), true);
	assert.equal(hasWranglerConfig(['wrangler.json']), true);
	assert.equal(hasWranglerConfig(['package.json']), false);
});

test('OpenNext beats plain Next and templates a missing wrangler config', () => {
	const detected = detectFramework(
		facts({ dependencies: { next: '15', '@opennextjs/cloudflare': '1' } })
	);
	assert.equal(detected?.id, 'nextjs-opennext');
	assert.equal(detected?.buildCommand, 'npx opennextjs-cloudflare build');
	assert.equal(detected?.outputDir, null);
	// No note, no homework: connect commits the config itself.
	assert.equal(detected?.note, null);
	assert.equal(detected?.wrangler?.main, '.open-next/worker.js');
	assert.equal(detected?.wrangler?.assetsDirectory, '.open-next/assets');

	const configured = detectFramework(
		facts({
			dependencies: { next: '15', '@opennextjs/cloudflare': '1' },
			hasWranglerConfig: true
		})
	);
	assert.equal(configured?.wrangler, null);
});

test('Next static export is detected from next.config source', () => {
	const detected = detectFramework(
		facts({
			dependencies: { next: '15' },
			nextConfigSource: "module.exports = { output: 'export' }"
		})
	);
	assert.equal(detected?.id, 'nextjs-export');
	assert.equal(detected?.outputDir, 'out');
	assert.equal(detected?.note, null);
});

test('Next without OpenNext still states `out` so a wrong setup fails loudly', () => {
	const detected = detectFramework(facts({ dependencies: { next: '15' } }));
	assert.equal(detected?.id, 'nextjs');
	assert.equal(detected?.outputDir, 'out');
	assert.match(detected?.note ?? '', /@opennextjs\/cloudflare/);
});

test('SvelteKit branches on the installed adapter', () => {
	const cloudflare = detectFramework(
		facts({
			dependencies: { '@sveltejs/kit': '2', '@sveltejs/adapter-cloudflare': '7' },
			hasWranglerConfig: true
		})
	);
	assert.equal(cloudflare?.id, 'sveltekit-cloudflare');
	assert.equal(cloudflare?.outputDir, null);
	assert.equal(cloudflare?.note, null);

	const missing = detectFramework(
		facts({ dependencies: { '@sveltejs/kit': '2', '@sveltejs/adapter-cloudflare': '7' } })
	);
	assert.equal(missing?.note, null);
	assert.equal(missing?.wrangler?.main, '.svelte-kit/cloudflare/_worker.js');
	assert.equal(missing?.wrangler?.assetsDirectory, '.svelte-kit/cloudflare');

	const isStatic = detectFramework(
		facts({ dependencies: { '@sveltejs/kit': '2', '@sveltejs/adapter-static': '3' } })
	);
	assert.equal(isStatic?.id, 'sveltekit-static');
	assert.equal(isStatic?.outputDir, 'build');

	const auto = detectFramework(
		facts({ dependencies: { '@sveltejs/kit': '2', '@sveltejs/adapter-auto': '3' } })
	);
	assert.equal(auto?.id, 'sveltekit');
	assert.match(auto?.note ?? '', /adapter-auto/);
});

test('Astro: static by default, adapter switches to the wrangler path', () => {
	const isStatic = detectFramework(facts({ dependencies: { astro: '5' } }));
	assert.equal(isStatic?.id, 'astro');
	assert.equal(isStatic?.outputDir, 'dist');

	const ssr = detectFramework(
		facts({
			dependencies: { astro: '5', '@astrojs/cloudflare': '12' },
			hasWranglerConfig: true
		})
	);
	assert.equal(ssr?.id, 'astro-cloudflare');
	assert.equal(ssr?.outputDir, null);
	assert.equal(ssr?.wrangler, null);

	const unconfigured = detectFramework(
		facts({ dependencies: { astro: '5', '@astrojs/cloudflare': '12' } })
	);
	assert.equal(unconfigured?.wrangler?.main, 'dist/_worker.js/index.js');
});

test('the committed wrangler.jsonc names the app and the adapter output', () => {
	const jsonc = wranglerConfigJsonc('sveltekit-cloudflare', 'landmatch');
	assert.match(jsonc, /"name": "landmatch"/);
	assert.match(jsonc, /"main": "\.svelte-kit\/cloudflare\/_worker\.js"/);
	assert.match(jsonc, /"directory": "\.svelte-kit\/cloudflare"/);
	assert.match(jsonc, /"binding": "ASSETS"/);
	assert.match(jsonc, /"nodejs_als"/);
	// Comments aside, the body is plain JSON - what jsonc parsers and
	// wrangler itself read.
	const body = jsonc
		.split('\n')
		.filter((line) => !line.trimStart().startsWith('//'))
		.join('\n');
	assert.doesNotThrow(() => JSON.parse(body));
});

test('Nuxt prerenders without wrangler, builds with it', () => {
	const generated = detectFramework(
		facts({ dependencies: { nuxt: '3' }, scripts: { build: 'nuxt build', generate: 'x' } })
	);
	assert.equal(generated?.buildCommand, 'npm run generate');
	assert.equal(generated?.outputDir, '.output/public');

	const worker = detectFramework(facts({ dependencies: { nuxt: '3' }, hasWranglerConfig: true }));
	assert.equal(worker?.id, 'nuxt-cloudflare');
	assert.equal(worker?.outputDir, null);
});

test('the build command honours the detected package manager', () => {
	const detected = detectFramework(facts({ dependencies: { astro: '5' }, packageManager: 'pnpm' }));
	assert.equal(detected?.buildCommand, 'pnpm run build');
});

test('a preset never prefills a script the repository does not have', () => {
	const detected = detectFramework(facts({ dependencies: { astro: '5' }, scripts: {} }));
	assert.equal(detected?.id, 'astro');
	assert.equal(detected?.buildCommand, null);
});

test('static generators: gatsby, docusaurus, vitepress, eleventy', () => {
	assert.equal(detectFramework(facts({ dependencies: { gatsby: '5' } }))?.outputDir, 'public');
	assert.equal(
		detectFramework(facts({ dependencies: { '@docusaurus/core': '3' } }))?.outputDir,
		'build'
	);
	const docs = detectFramework(
		facts({ dependencies: { vitepress: '1' }, rootEntries: ['package.json', 'docs'] })
	);
	assert.equal(docs?.outputDir, 'docs/.vitepress/dist');
	const rootMode = detectFramework(
		facts({ dependencies: { vitepress: '1' }, rootEntries: ['package.json', '.vitepress'] })
	);
	assert.equal(rootMode?.outputDir, '.vitepress/dist');
	const eleventy = detectFramework(facts({ dependencies: { '@11ty/eleventy': '3' }, scripts: {} }));
	assert.equal(eleventy?.buildCommand, 'npx @11ty/eleventy');
	assert.equal(eleventy?.outputDir, '_site');
});

test('generic Vite comes last so framework adapters win', () => {
	const detected = detectFramework(facts({ dependencies: { vite: '6', astro: '5' } }));
	assert.equal(detected?.id, 'astro');
	assert.equal(detectFramework(facts({ dependencies: { vite: '6' } }))?.id, 'vite');
});

test('Hugo needs a Hugo-shaped repo, not just a config.toml', () => {
	const hugo = detectFramework(facts({ rootEntries: ['hugo.toml', 'content'], scripts: {} }));
	assert.equal(hugo?.id, 'hugo');
	assert.equal(hugo?.buildCommand, 'hugo --minify');

	const ambiguous = detectFramework(facts({ rootEntries: ['config.toml'], scripts: {} }));
	assert.equal(ambiguous, null);

	const shaped = detectFramework(
		facts({ rootEntries: ['config.toml', 'content', 'themes'], scripts: {} })
	);
	assert.equal(shaped?.id, 'hugo');
});

test('Jekyll suggests direct mode over an unsupported build', () => {
	const detected = detectFramework(
		facts({ rootEntries: ['_config.yml', 'Gemfile', '_site'], scripts: {} })
	);
	assert.equal(detected?.mode, 'direct');
	assert.equal(detected?.buildCommand, null);
	assert.equal(detected?.outputDir, '_site');
});

test('an unrecognized repository detects nothing', () => {
	assert.equal(detectFramework(facts({ dependencies: { express: '4' } })), null);
});
