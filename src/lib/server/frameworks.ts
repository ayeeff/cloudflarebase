/**
 * Framework presets for GitHub connections (docs/managed-service-design.md,
 * Phase B) - the CF-Pages-style table that turns "we read your package.json"
 * into a populated build command and output directory at connect time.
 *
 * Deliberately a pure module with zero imports so `npm run test:unit` can pin
 * the detection matrix without booting anything. The connect dialog shows what
 * was detected and the operator can always override; detection only decides
 * the PREFILL, never the contract.
 *
 * Two failure philosophies encoded here:
 * - A framework that needs a Cloudflare adapter it does not have gets a NOTE,
 *   not a silent generic preset - the build would succeed and deploy the
 *   wrong thing (or nothing), which is worse than saying so up front.
 * - A preset whose output directory we know is stated EXPLICITLY even when
 *   the deploy would fail without it (Next.js without `output: 'export'`),
 *   because a loud "out does not exist" beats autodetection finding the
 *   repo's `public/` SOURCE directory and publishing that as the site.
 */

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface RepoFacts {
	/** dependencies + devDependencies, merged (version ranges unused). */
	dependencies: Record<string, string>;
	scripts: Record<string, string>;
	packageManager: PackageManager;
	/** File and directory names at the repository root. */
	rootEntries: string[];
	/** wrangler.jsonc / wrangler.json / wrangler.toml at the root. */
	hasWranglerConfig: boolean;
	/** next.config.* source, fetched only when `next` is a dependency. */
	nextConfigSource: string | null;
}

export interface FrameworkPreset {
	id: string;
	label: string;
	/** 'build' needs a runner; 'direct' is deployable as committed. */
	mode: 'build' | 'direct';
	/** Null = no runnable build (direct mode, or a missing script). */
	buildCommand: string | null;
	/** Null = wrangler-driven or autodetected at deploy time. */
	outputDir: string | null;
	/** Guidance the dialog surfaces - adapter missing, path caveats. */
	note: string | null;
}

/** Lockfile first, `packageManager` field as the tiebreak - a repo with a
 * pnpm lockfile is a pnpm repo no matter what the field says is newest. */
export function detectPackageManager(
	rootEntries: string[],
	packageManagerField: string | null | undefined
): PackageManager {
	const has = (name: string): boolean => rootEntries.includes(name);
	if (has('pnpm-lock.yaml')) return 'pnpm';
	if (has('bun.lockb') || has('bun.lock')) return 'bun';
	if (has('yarn.lock')) return 'yarn';
	if (has('package-lock.json') || has('npm-shrinkwrap.json')) return 'npm';
	const field = packageManagerField?.split('@')[0];
	if (field === 'pnpm' || field === 'yarn' || field === 'bun') return field;
	return 'npm';
}

const WRANGLER_CONFIGS = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];

export function hasWranglerConfig(rootEntries: string[]): boolean {
	return WRANGLER_CONFIGS.some((name) => rootEntries.includes(name));
}

/** `<pm> run <script>` when the script exists, else null - a preset must
 * never prefill a command the repository cannot run. */
function runScript(facts: RepoFacts, script: string): string | null {
	if (typeof facts.scripts[script] !== 'string') return null;
	return `${facts.packageManager} run ${script}`;
}

function preset(
	id: string,
	label: string,
	partial: Partial<Omit<FrameworkPreset, 'id' | 'label'>>
): FrameworkPreset {
	return {
		id,
		label,
		mode: 'build',
		buildCommand: null,
		outputDir: null,
		note: null,
		...partial
	};
}

/** Appended when a wrangler-driven preset finds no wrangler config: without
 * it the deploy has no `main` and would fall back to a wrong assets guess. */
function wranglerNote(facts: RepoFacts, hint: string): string | null {
	return facts.hasWranglerConfig ? null : hint;
}

/**
 * Maps repository facts to a framework preset, most specific first. Null
 * means "no framework we recognize" - the caller falls back to the legacy
 * build-script / committed-directory heuristics.
 */
export function detectFramework(facts: RepoFacts): FrameworkPreset | null {
	const deps = facts.dependencies;
	const has = (name: string): boolean => typeof deps[name] === 'string';
	const root = (name: string): boolean => facts.rootEntries.includes(name);
	const build = runScript(facts, 'build');

	// --- Next.js ----------------------------------------------------------
	if (has('@opennextjs/cloudflare')) {
		return preset('nextjs-opennext', 'Next.js (OpenNext)', {
			buildCommand: 'npx opennextjs-cloudflare build',
			note: wranglerNote(
				facts,
				'OpenNext needs the wrangler.jsonc its setup generates (main: .open-next/worker.js).'
			)
		});
	}
	if (has('next')) {
		const isExport = /output\s*:\s*['"]export['"]/.test(facts.nextConfigSource ?? '');
		if (isExport) {
			return preset('nextjs-export', 'Next.js (static export)', {
				buildCommand: build,
				outputDir: 'out'
			});
		}
		return preset('nextjs', 'Next.js', {
			buildCommand: build,
			// Deliberate: a missing `out` fails loudly instead of autodetection
			// publishing the repo's `public/` source directory as the site.
			outputDir: 'out',
			note: 'Server rendering needs @opennextjs/cloudflare; a static site should set `output: "export"` in next.config.'
		});
	}

	// --- SvelteKit --------------------------------------------------------
	if (has('@sveltejs/kit')) {
		if (has('@sveltejs/adapter-cloudflare')) {
			return preset('sveltekit-cloudflare', 'SvelteKit (Cloudflare adapter)', {
				buildCommand: build,
				note: wranglerNote(
					facts,
					'Add a wrangler.jsonc with main ".svelte-kit/cloudflare/_worker.js" and assets.directory ".svelte-kit/cloudflare".'
				)
			});
		}
		if (has('@sveltejs/adapter-static')) {
			return preset('sveltekit-static', 'SvelteKit (static)', {
				buildCommand: build,
				outputDir: 'build'
			});
		}
		return preset('sveltekit', 'SvelteKit', {
			buildCommand: build,
			note: 'adapter-auto cannot detect this environment - install @sveltejs/adapter-cloudflare (server rendering) or @sveltejs/adapter-static.'
		});
	}

	// --- Astro ------------------------------------------------------------
	if (has('astro')) {
		if (has('@astrojs/cloudflare')) {
			return preset('astro-cloudflare', 'Astro (Cloudflare adapter)', {
				buildCommand: build,
				note: wranglerNote(
					facts,
					'Add a wrangler.jsonc with main "dist/_worker.js/index.js" and assets.directory "dist".'
				)
			});
		}
		return preset('astro', 'Astro', { buildCommand: build, outputDir: 'dist' });
	}

	// --- Nuxt -------------------------------------------------------------
	if (has('nuxt')) {
		if (facts.hasWranglerConfig) {
			return preset('nuxt-cloudflare', 'Nuxt (Cloudflare preset)', { buildCommand: build });
		}
		return preset('nuxt', 'Nuxt', {
			buildCommand: runScript(facts, 'generate') ?? 'npx nuxt generate',
			outputDir: '.output/public',
			note: 'Prerendered with `nuxt generate`; server routes need the cloudflare_module Nitro preset and a wrangler.jsonc.'
		});
	}

	// --- React Router 7 / Remix -------------------------------------------
	if (has('@react-router/dev') || has('@remix-run/dev')) {
		const label = has('@remix-run/dev') ? 'Remix' : 'React Router';
		if (facts.hasWranglerConfig) {
			return preset('react-router-cloudflare', `${label} (Cloudflare)`, { buildCommand: build });
		}
		return preset('react-router', label, {
			buildCommand: build,
			outputDir: 'build/client',
			note: 'Only the client build deploys as static files - server rendering needs the Cloudflare template and its wrangler.jsonc.'
		});
	}

	// --- Static site generators -------------------------------------------
	if (has('gatsby')) {
		return preset('gatsby', 'Gatsby', { buildCommand: build, outputDir: 'public' });
	}
	if (has('@docusaurus/core')) {
		return preset('docusaurus', 'Docusaurus', { buildCommand: build, outputDir: 'build' });
	}
	if (has('vitepress')) {
		const docsMode = root('docs') && !root('.vitepress');
		return preset('vitepress', 'VitePress', {
			buildCommand: runScript(facts, 'docs:build') ?? build,
			outputDir: docsMode ? 'docs/.vitepress/dist' : '.vitepress/dist'
		});
	}
	if (has('@11ty/eleventy')) {
		return preset('eleventy', 'Eleventy', {
			buildCommand: build ?? 'npx @11ty/eleventy',
			outputDir: '_site'
		});
	}

	// --- SPA toolchains ----------------------------------------------------
	if (has('@angular/core')) {
		return preset('angular', 'Angular', {
			buildCommand: build,
			outputDir: 'dist',
			note: 'Angular 17+ emits dist/<project>/browser - set the output directory to that path.'
		});
	}
	if (has('react-scripts')) {
		return preset('cra', 'Create React App', { buildCommand: build, outputDir: 'build' });
	}
	if (has('@vue/cli-service')) {
		return preset('vue-cli', 'Vue CLI', { buildCommand: build, outputDir: 'dist' });
	}
	// Generic Vite last: every modern framework above also depends on it.
	if (has('vite')) {
		return preset('vite', 'Vite', { buildCommand: build, outputDir: 'dist' });
	}

	// --- Non-npm generators ------------------------------------------------
	// Hugo is preinstalled on GitHub's ubuntu runners, so a build preset works
	// with no package.json at all. config.toml alone is ambiguous (many tools
	// use it) - require a Hugo-shaped repo around it.
	if (
		root('hugo.toml') ||
		root('hugo.yaml') ||
		(root('config.toml') && (root('content') || root('themes') || root('archetypes')))
	) {
		return preset('hugo', 'Hugo', {
			buildCommand: 'hugo --minify',
			outputDir: 'public',
			note: 'Built with the Hugo preinstalled on GitHub runners.'
		});
	}
	// Jekyll needs a Ruby toolchain we do not set up; committed output works.
	if (root('_config.yml') && root('Gemfile')) {
		return preset('jekyll', 'Jekyll', {
			mode: 'direct',
			outputDir: '_site',
			note: 'Jekyll builds are not supported yet - commit the built _site directory, or add an npm build script.'
		});
	}

	return null;
}
