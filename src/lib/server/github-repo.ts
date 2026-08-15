import { githubFetch, installationToken, type GithubAppConfig } from '$lib/server/github';
import { WORKFLOW_FILENAME } from '$lib/hosting-workflow';
import type { ConnectionMode } from '$lib/server/github-connect';
import {
	detectFramework,
	detectPackageManager,
	hasWranglerConfig,
	type FrameworkPreset,
	type PackageManager
} from '$lib/server/frameworks';

/**
 * Repository-facing GitHub operations: what the connect flow reads, what it
 * writes, and where a direct-mode deploy gets its bytes.
 *
 * Every call goes through an installation token, which is scoped to the
 * repositories the operator picked at install time - so an operator can only
 * ever reach repositories they deliberately granted.
 */

export interface RepoSummary {
	id: number;
	fullName: string;
	defaultBranch: string;
	private: boolean;
	updatedAt: string | null;
}

/** The repositories an installation can see, newest activity first. */
export async function listInstallationRepos(
	config: GithubAppConfig,
	installationId: number
): Promise<RepoSummary[] | null> {
	const token = await installationToken(config, installationId);
	if (!token) return null;

	const repos: RepoSummary[] = [];
	// Installations can hold hundreds of repos; page until GitHub runs out or
	// we hit a sane ceiling for a picker.
	for (let page = 1; page <= 5; page += 1) {
		const response = await githubFetch(
			token,
			'GET',
			`/installation/repositories?per_page=100&page=${page}`
		);
		if (!response.ok) return repos.length ? repos : null;
		const body = response.body as { repositories?: Record<string, unknown>[] } | null;
		const batch = body?.repositories ?? [];
		for (const repo of batch) {
			if (typeof repo.id !== 'number' || typeof repo.full_name !== 'string') continue;
			repos.push({
				id: repo.id,
				fullName: repo.full_name,
				defaultBranch: typeof repo.default_branch === 'string' ? repo.default_branch : 'main',
				private: repo.private === true,
				updatedAt: typeof repo.updated_at === 'string' ? repo.updated_at : null
			});
		}
		if (batch.length < 100) break;
	}
	repos.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
	return repos;
}

function decodeContent(body: unknown): string | null {
	const file = body as { content?: string; encoding?: string } | null;
	if (!file?.content || file.encoding !== 'base64') return null;
	try {
		return atob(file.content.replace(/\s+/g, ''));
	} catch {
		return null;
	}
}

/** Conventional build outputs, in the order the CLI already searches. */
const STATIC_DIRS = ['dist', 'build', 'public', '_site', 'out'];

export interface RepoInspection {
	/** What the connect UI preselects; the operator can always override. */
	suggestedMode: ConnectionMode;
	/** Direct mode only: repo-relative assets directory ('' = repo root). */
	assetsDir: string;
	hasBuildScript: boolean;
	/** Directories that look like committed static output. */
	staticDirs: string[];
	hasIndexHtml: boolean;
	/** Framework preset (src/lib/server/frameworks.ts); null = unrecognized. */
	framework: Pick<FrameworkPreset, 'id' | 'label' | 'note'> | null;
	/** Build-mode prefill: the preset's command, else `<pm> run build`. */
	buildCommand: string | null;
	/** Build-mode prefill: where the build lands; '' = autodetect. */
	outputDir: string;
	packageManager: PackageManager;
	/** False when a requested root directory does not exist on the ref -
	 * the dialog warns instead of connecting a repo that can never build. */
	rootDirExists: boolean;
	/** True when connect will commit a wrangler.jsonc alongside the workflow
	 * (the preset needs one, the repo has none). */
	writesWrangler: boolean;
}

/**
 * Decides whether a repository needs a runner, and which framework preset
 * populates the connect dialog (CF-Pages-style: build command and output
 * directory prefilled, operator can override).
 *
 * The mode split is the whole Tier-1-vs-Tier-1.5 line: a repo with a build
 * has to be built somewhere, and that somewhere is GitHub's runners. A repo
 * that is already deployable as it stands - committed HTML, or a committed
 * output directory - needs no runner and no file in the repo at all, so the
 * push webhook can deploy it directly.
 *
 * A repo we cannot read falls back to build mode, which degrades to "the
 * runner tries and reports", rather than direct mode, which would silently
 * publish the wrong tree.
 */
export async function inspectRepo(
	config: GithubAppConfig,
	installationId: number,
	repoFullName: string,
	ref: string,
	rootDir: string | null = null
): Promise<RepoInspection> {
	const dir = rootDir?.replace(/^\/+|\/+$/g, '') || null;
	const fallback: RepoInspection = {
		suggestedMode: 'build',
		assetsDir: '',
		hasBuildScript: false,
		staticDirs: [],
		hasIndexHtml: false,
		framework: null,
		buildCommand: null,
		outputDir: '',
		packageManager: 'npm',
		rootDirExists: true,
		writesWrangler: false
	};
	const token = await installationToken(config, installationId);
	if (!token) return fallback;

	const query = `?ref=${encodeURIComponent(ref)}`;
	const base = dir ? `/repos/${repoFullName}/contents/${dir}` : `/repos/${repoFullName}/contents`;
	const [packageResponse, rootResponse, repoRootResponse] = await Promise.all([
		githubFetch(token, 'GET', `${base}/package.json${query}`),
		githubFetch(token, 'GET', `${base}${query}`),
		// Monorepo lockfiles live at the REPOSITORY root, not beside the
		// package - the union below is what makes pnpm detection work there.
		dir
			? githubFetch(token, 'GET', `/repos/${repoFullName}/contents${query}`)
			: Promise.resolve(null)
	]);
	if (dir && !rootResponse.ok) {
		return { ...fallback, rootDirExists: false };
	}

	let hasBuildScript = false;
	let dependencies: Record<string, string> = {};
	let scripts: Record<string, string> = {};
	let packageManagerField: string | null = null;
	if (packageResponse.ok) {
		const raw = decodeContent(packageResponse.body);
		if (raw) {
			try {
				const parsed = JSON.parse(raw) as {
					scripts?: Record<string, unknown>;
					dependencies?: Record<string, unknown>;
					devDependencies?: Record<string, unknown>;
					packageManager?: unknown;
				};
				hasBuildScript = typeof parsed.scripts?.build === 'string';
				scripts = onlyStrings(parsed.scripts);
				dependencies = {
					...onlyStrings(parsed.dependencies),
					...onlyStrings(parsed.devDependencies)
				};
				packageManagerField =
					typeof parsed.packageManager === 'string' ? parsed.packageManager : null;
			} catch {
				// An unparseable package.json is a build-mode repo with a problem;
				// the runner will say so far more clearly than we can here.
				hasBuildScript = true;
			}
		}
	}

	const entries = (rootResponse.ok ? rootResponse.body : null) as
		{ name?: string; type?: string }[] | null;
	const names = Array.isArray(entries) ? entries : [];
	const rootEntries = names
		.map((entry) => entry.name)
		.filter((name): name is string => typeof name === 'string');
	const hasIndexHtml = names.some((entry) => entry.name === 'index.html' && entry.type === 'file');
	const staticDirs = STATIC_DIRS.filter((name) =>
		names.some((entry) => entry.name === name && entry.type === 'dir')
	);

	// Lockfiles: the root directory's own, unioned with the repository
	// root's - a workspace keeps ONE lockfile at the top.
	const repoRootNames = Array.isArray(repoRootResponse?.body)
		? (repoRootResponse.body as { name?: string }[])
				.map((entry) => entry.name)
				.filter((name): name is string => typeof name === 'string')
		: [];
	const packageManager = detectPackageManager(
		[...rootEntries, ...repoRootNames],
		packageManagerField
	);
	// next.config decides static-export vs server rendering, and only Next
	// repos pay the extra read. OpenNext repos skip it: the adapter wins.
	let nextConfigSource: string | null = null;
	if (dependencies.next && !dependencies['@opennextjs/cloudflare']) {
		const configName = rootEntries.find((name) => /^next\.config\.(?:js|mjs|ts)$/.test(name));
		if (configName) {
			const configResponse = await githubFetch(token, 'GET', `${base}/${configName}${query}`);
			if (configResponse.ok) nextConfigSource = decodeContent(configResponse.body);
		}
	}

	const preset = detectFramework({
		dependencies,
		scripts,
		packageManager,
		rootEntries,
		hasWranglerConfig: hasWranglerConfig(rootEntries),
		nextConfigSource
	});
	const framework = preset ? { id: preset.id, label: preset.label, note: preset.note } : null;
	const common = {
		hasBuildScript,
		staticDirs,
		hasIndexHtml,
		framework,
		packageManager,
		rootDirExists: true as const,
		writesWrangler: preset?.wrangler != null
	};

	if (preset && preset.mode === 'build' && preset.buildCommand) {
		return {
			...common,
			suggestedMode: 'build',
			assetsDir: '',
			buildCommand: preset.buildCommand,
			outputDir: preset.outputDir ?? ''
		};
	}
	if (preset && preset.mode === 'direct') {
		const suggested =
			preset.outputDir && staticDirs.includes(preset.outputDir) ? preset.outputDir : '';
		return {
			...common,
			suggestedMode: 'direct',
			assetsDir: suggested || staticDirs[0] || '',
			buildCommand: null,
			outputDir: ''
		};
	}

	// No runnable preset: the legacy heuristics, now framework-labelled when
	// we at least recognized what it is (a preset whose script is missing).
	if (hasBuildScript) {
		return {
			...common,
			suggestedMode: 'build',
			assetsDir: '',
			buildCommand: `${packageManager} run build`,
			outputDir: ''
		};
	}
	if (staticDirs.length) {
		return {
			...common,
			suggestedMode: 'direct',
			assetsDir: staticDirs[0],
			buildCommand: null,
			outputDir: ''
		};
	}
	if (hasIndexHtml) {
		return {
			...common,
			suggestedMode: 'direct',
			assetsDir: '',
			buildCommand: null,
			outputDir: ''
		};
	}
	return { ...fallback, ...common, buildCommand: null, outputDir: '' };
}

function onlyStrings(record: Record<string, unknown> | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(record ?? {})) {
		if (typeof value === 'string') out[key] = value;
	}
	return out;
}

/**
 * Creates or updates a file on a branch.
 *
 * `PUT contents` needs the blob sha to replace an existing file, so this
 * reads first. Reconnecting therefore rewrites rather than conflicting,
 * which is what makes "connect again with different settings" work.
 */
export async function writeRepoFile(
	config: GithubAppConfig,
	installationId: number,
	repoFullName: string,
	branch: string,
	filePath: string,
	content: string,
	message: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
	const token = await installationToken(config, installationId);
	if (!token) {
		return { ok: false, status: 409, error: 'the GitHub installation is no longer valid' };
	}

	const path = `/repos/${repoFullName}/contents/${filePath}`;
	const existing = await githubFetch(token, 'GET', `${path}?ref=${encodeURIComponent(branch)}`);
	const sha =
		existing.ok && typeof (existing.body as { sha?: string })?.sha === 'string'
			? (existing.body as { sha: string }).sha
			: undefined;

	const response = await githubFetch(token, 'PUT', path, {
		message,
		content: btoa(content),
		branch,
		...(sha ? { sha } : {})
	});
	if (response.ok) return { ok: true };

	const error = (response.body as { message?: string } | null)?.message;
	if (response.status === 403 || response.status === 404) {
		return {
			ok: false,
			status: 403,
			// The overwhelmingly common cause, and not guessable from GitHub's text.
			error: `GitHub refused to write ${filePath}: ${error ?? 'permission denied'}. Grant the app Contents and Workflows write access on this repository.`
		};
	}
	return { ok: false, status: 502, error: error ?? `GitHub refused to write ${filePath}` };
}

/** The deploy workflow, on the default branch. */
export async function writeWorkflowFile(
	config: GithubAppConfig,
	installationId: number,
	repoFullName: string,
	branch: string,
	yaml: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
	return writeRepoFile(
		config,
		installationId,
		repoFullName,
		branch,
		WORKFLOW_FILENAME,
		yaml,
		'Add Cloudflarebase deploy workflow'
	);
}

/**
 * Whether any wrangler config exists under `dir` on the ref. Checked
 * server-side immediately before connect commits one: the inspection's
 * answer is a client round trip old, and overwriting a config the user
 * pushed in between would be destructive. Null = could not check (treated
 * as "exists" by the caller, for the same reason).
 */
export async function repoHasWranglerConfig(
	config: GithubAppConfig,
	installationId: number,
	repoFullName: string,
	ref: string,
	dir: string | null
): Promise<boolean | null> {
	const token = await installationToken(config, installationId);
	if (!token) return null;
	const prefix = dir ? `${dir}/` : '';
	const query = `?ref=${encodeURIComponent(ref)}`;
	const checks = await Promise.all(
		['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].map((name) =>
			githubFetch(token, 'GET', `/repos/${repoFullName}/contents/${prefix}${name}${query}`)
		)
	);
	return checks.some((response) => response.ok);
}

/** Removes the managed workflow on disconnect. Best effort: the connection
 * row is the real switch, this just stops the repo failing CI forever. */
export async function deleteWorkflowFile(
	config: GithubAppConfig,
	installationId: number,
	repoFullName: string,
	branch: string
): Promise<boolean> {
	const token = await installationToken(config, installationId);
	if (!token) return false;

	const path = `/repos/${repoFullName}/contents/${WORKFLOW_FILENAME}`;
	const existing = await githubFetch(token, 'GET', `${path}?ref=${encodeURIComponent(branch)}`);
	const sha = (existing.body as { sha?: string } | null)?.sha;
	if (!existing.ok || !sha) return false;

	const response = await githubFetch(token, 'DELETE', path, {
		message: 'Remove Cloudflarebase deploy workflow',
		branch,
		sha
	});
	return response.ok;
}

/**
 * A short-lived, unauthenticated download URL for a commit's source tarball.
 *
 * GitHub answers the tarball endpoint with a 302 to a signed codeload URL, so
 * resolving the redirect HERE means the installation token never has to leave
 * the control plane - the hosting agent receives a plain URL it can fetch.
 */
export async function repoTarballUrl(
	config: GithubAppConfig,
	installationId: number,
	repoFullName: string,
	ref: string
): Promise<string | null> {
	const token = await installationToken(config, installationId);
	if (!token) return null;

	const response = await fetch(
		`https://api.github.com/repos/${repoFullName}/tarball/${encodeURIComponent(ref)}`,
		{
			method: 'HEAD',
			redirect: 'manual',
			headers: {
				authorization: `Bearer ${token}`,
				accept: 'application/vnd.github+json',
				'user-agent': 'cloudflarebase'
			}
		}
	).catch(() => null);

	if (!response || response.status < 300 || response.status >= 400) return null;
	return response.headers.get('location');
}
