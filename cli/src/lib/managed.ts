import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { UserError } from './log.js';
import { run } from './run.js';

/**
 * Managed hosting support (docs/managed-service-design.md, Phase B):
 * `cloudflarebase.json` marks a project as linked to a console, and `deploy`
 * branches on its presence - present means managed deploy against the
 * console's hosting API, absent means the self-hosted wrangler path.
 */

export const MANAGED_FILE = 'cloudflarebase.json';

// Mirrors projectIdSchema in the console and the agents (48 chars: a branch
// id is `<root>--<branch>`, so the ceiling has to hold both).
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const BRANCH_NAME = /^[a-z0-9][a-z0-9-]{0,15}$/;
/** Mirrors the console's appNameSchema. */
export const APP_NAME = /^[a-z0-9][a-z0-9-]{2,47}$/;

export interface ManagedConfig {
	/** The ROOT project id; the branch is decided per deploy. */
	project: string;
	app: string;
	origin: string;
	/** Plain-text vars injected into the deployed Worker. */
	vars?: Record<string, string>;
	/** Assets directory override (else wrangler.jsonc `assets.directory`,
	 * else the first of dist/build/public/_site/out that exists). */
	assets?: string;
}

export async function readManagedConfig(projectDir: string): Promise<ManagedConfig | null> {
	let raw: string;
	try {
		raw = await readFile(path.join(projectDir, MANAGED_FILE), 'utf8');
	} catch {
		return null;
	}
	const parsed = JSON.parse(raw) as Partial<ManagedConfig>;
	if (
		typeof parsed.project !== 'string' ||
		typeof parsed.app !== 'string' ||
		typeof parsed.origin !== 'string' ||
		!PROJECT_ID.test(parsed.project) ||
		!APP_NAME.test(parsed.app)
	) {
		throw new UserError(
			`${MANAGED_FILE} is malformed.`,
			'Run `cloudflarebase init` again to reconnect this directory.'
		);
	}
	return {
		project: parsed.project,
		app: parsed.app,
		origin: new URL(parsed.origin).origin,
		vars: typeof parsed.vars === 'object' && parsed.vars ? parsed.vars : undefined,
		assets: typeof parsed.assets === 'string' ? parsed.assets : undefined
	};
}

export async function writeManagedConfig(
	projectDir: string,
	config: ManagedConfig
): Promise<string> {
	const file = path.join(projectDir, MANAGED_FILE);
	await writeFile(file, `${JSON.stringify(config, null, '\t')}\n`, 'utf8');
	return file;
}

/**
 * Authenticated fetch against the console's hosting surface. Deliberately not
 * `consoleFetch`: the bearer here may be a deploy token, whose 401 means
 * "revoked or wrong project", not "sign in again".
 */
export async function hostingFetch(
	origin: string,
	token: string,
	route: string,
	init: { method?: string; body?: string | FormData; headers?: Record<string, string> } = {}
): Promise<Response> {
	return fetch(`${origin}${route}`, {
		method: init.method ?? 'GET',
		headers: {
			authorization: `Bearer ${token}`,
			origin,
			...(init.headers ?? {})
		},
		body: init.body
	}).catch((cause: unknown) => {
		throw new UserError(
			`Could not reach ${origin}.`,
			cause instanceof Error ? cause.message : undefined
		);
	});
}

/**
 * Git branch -> cloudflarebase branch. The DEFAULT git branch maps to the
 * root project (`main` never appears anywhere - it aliases the root); any
 * other branch maps to `<root>--<branch>` after charset sanitizing. Returns
 * null for the root.
 */
export async function resolveGitBranch(projectDir: string): Promise<string | null> {
	// CI first: actions/checkout leaves a detached HEAD, so `rev-parse` cannot
	// name the branch there. The official workflow passes both vars; plain
	// GitHub Actions still gets GITHUB_REF_NAME with a main/master heuristic.
	const envBranch =
		process.env.CLOUDFLAREBASE_GIT_BRANCH?.trim() || process.env.GITHUB_REF_NAME?.trim();
	if (envBranch) {
		const envDefault = process.env.CLOUDFLAREBASE_DEFAULT_BRANCH?.trim();
		const isDefault = envDefault
			? envBranch === envDefault
			: envBranch === 'main' || envBranch === 'master';
		return isDefault ? null : envBranch;
	}

	const current = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
		cwd: projectDir,
		capture: true
	});
	if (current.code !== 0) return null; // not a git repository -> root
	const branch = current.stdout.trim();
	if (!branch || branch === 'HEAD') return null; // detached -> root

	const head = await run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
		cwd: projectDir,
		capture: true
	});
	const defaultBranch = head.code === 0 ? head.stdout.trim().replace(/^origin\//, '') : null;
	if (defaultBranch ? branch === defaultBranch : branch === 'main' || branch === 'master') {
		return null;
	}
	return branch;
}

/** Charset-sanitizes a git branch name into a cloudflarebase branch name. */
export function sanitizeBranchName(branch: string): string {
	const cleaned = branch
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/-{2,}/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 16)
		.replace(/-+$/, '');
	if (!BRANCH_NAME.test(cleaned)) {
		throw new UserError(
			`Git branch "${branch}" cannot be mapped to a cloudflarebase branch name.`,
			'Branch names are 1-16 lowercase letters, numbers, and hyphens. Pass --branch <name> to pick one.'
		);
	}
	return cleaned;
}

/** Composes the target project id for a deploy, honouring the 48-char ceiling. */
export function targetProjectId(root: string, branch: string | null): string {
	if (!PROJECT_ID.test(root) || root.includes('--')) {
		throw new UserError(`"${root}" is not a valid root project id.`);
	}
	if (!branch) return root;
	if (branch === 'main') return root; // main aliases the root everywhere
	const id = `${root}--${branch}`;
	if (!PROJECT_ID.test(id)) {
		throw new UserError(
			'The combined project id exceeds 48 characters - use a shorter branch name.'
		);
	}
	return id;
}

export interface CollectedFile {
	/** URL path (`/index.html`) for assets, file name for modules. */
	name: string;
	bytes: Buffer;
}

// Mirror the agent's caps so failures happen before any upload starts.
const MAX_ASSET_COUNT = 1000;
const MAX_ASSET_TOTAL_BYTES = 25 * 1024 * 1024;

/** Recursively collects an assets directory into `/path` entries. */
export async function collectAssets(dir: string): Promise<CollectedFile[]> {
	const files: CollectedFile[] = [];
	let total = 0;

	async function walk(current: string, prefix: string): Promise<void> {
		const entries = await readdir(current, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				await walk(full, `${prefix}/${entry.name}`);
				continue;
			}
			if (!entry.isFile()) continue;
			const bytes = await readFile(full);
			total += bytes.length;
			files.push({ name: `${prefix}/${entry.name}`, bytes });
			if (files.length > MAX_ASSET_COUNT) {
				throw new UserError(`More than ${MAX_ASSET_COUNT} asset files in ${dir}.`);
			}
			if (total > MAX_ASSET_TOTAL_BYTES) {
				throw new UserError(`Assets in ${dir} exceed 25 MB.`);
			}
		}
	}

	await walk(dir, '');
	return files;
}

/** The user's wrangler config, when one exists - the managed deploy respects
 * its `main`, `assets.directory`, and compatibility settings. */
export async function readUserWranglerConfig(projectDir: string): Promise<{
	main?: string;
	assetsDirectory?: string;
	compatibilityDate?: string;
	compatibilityFlags?: string[];
} | null> {
	for (const name of ['wrangler.jsonc', 'wrangler.json']) {
		let raw: string;
		try {
			raw = await readFile(path.join(projectDir, name), 'utf8');
		} catch {
			continue;
		}
		const config = parseJsonc(raw) as Record<string, unknown> | undefined;
		if (!config) return null;
		const assets = config.assets as { directory?: string } | undefined;
		return {
			main: typeof config.main === 'string' ? config.main : undefined,
			assetsDirectory: typeof assets?.directory === 'string' ? assets.directory : undefined,
			compatibilityDate:
				typeof config.compatibility_date === 'string' ? config.compatibility_date : undefined,
			compatibilityFlags: Array.isArray(config.compatibility_flags)
				? (config.compatibility_flags as string[]).filter(
						(flag) => typeof flag === 'string' && /^[a-z0-9_]+$/.test(flag)
					)
				: undefined
		};
	}
	return null;
}

/** Finds the assets directory: explicit override, wrangler config, then the
 * conventional build outputs. Null when nothing exists. */
export async function findAssetsDirectory(
	projectDir: string,
	override: string | undefined,
	fromWrangler: string | undefined
): Promise<string | null> {
	const candidates = override
		? [override]
		: fromWrangler
			? [fromWrangler]
			: ['dist', 'build', 'public', '_site', 'out'];
	for (const candidate of candidates) {
		const full = path.resolve(projectDir, candidate);
		try {
			if ((await stat(full)).isDirectory()) return full;
		} catch {
			// keep looking
		}
	}
	if (override || fromWrangler) {
		throw new UserError(`Assets directory "${override ?? fromWrangler}" does not exist.`);
	}
	return null;
}
