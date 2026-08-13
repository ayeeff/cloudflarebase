import { githubFetch, installationToken, type GithubAppConfig } from '$lib/server/github';
import { WORKFLOW_FILENAME } from '$lib/hosting-workflow';
import type { ConnectionMode } from '$lib/server/github-connect';

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
}

/**
 * Decides whether a repository needs a runner.
 *
 * This is the whole Tier-1-vs-Tier-1.5 split: a repo with a `build` script
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
	ref: string
): Promise<RepoInspection> {
	const fallback: RepoInspection = {
		suggestedMode: 'build',
		assetsDir: '',
		hasBuildScript: false,
		staticDirs: [],
		hasIndexHtml: false
	};
	const token = await installationToken(config, installationId);
	if (!token) return fallback;

	const query = `?ref=${encodeURIComponent(ref)}`;
	const [packageResponse, rootResponse] = await Promise.all([
		githubFetch(token, 'GET', `/repos/${repoFullName}/contents/package.json${query}`),
		githubFetch(token, 'GET', `/repos/${repoFullName}/contents${query}`)
	]);

	let hasBuildScript = false;
	if (packageResponse.ok) {
		const raw = decodeContent(packageResponse.body);
		if (raw) {
			try {
				const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
				hasBuildScript = typeof parsed.scripts?.build === 'string';
			} catch {
				// An unparseable package.json is a build-mode repo with a problem;
				// the runner will say so far more clearly than we can here.
				hasBuildScript = true;
			}
		}
	}

	const entries = (rootResponse.ok ? rootResponse.body : null) as
		| { name?: string; type?: string }[]
		| null;
	const names = Array.isArray(entries) ? entries : [];
	const hasIndexHtml = names.some((entry) => entry.name === 'index.html' && entry.type === 'file');
	const staticDirs = STATIC_DIRS.filter((dir) =>
		names.some((entry) => entry.name === dir && entry.type === 'dir')
	);

	if (hasBuildScript) {
		return { suggestedMode: 'build', assetsDir: '', hasBuildScript, staticDirs, hasIndexHtml };
	}
	if (staticDirs.length) {
		return {
			suggestedMode: 'direct',
			assetsDir: staticDirs[0],
			hasBuildScript,
			staticDirs,
			hasIndexHtml
		};
	}
	if (hasIndexHtml) {
		return { suggestedMode: 'direct', assetsDir: '', hasBuildScript, staticDirs, hasIndexHtml };
	}
	return { ...fallback, staticDirs, hasIndexHtml };
}

/**
 * Creates or updates the deploy workflow on the default branch.
 *
 * `PUT contents` needs the blob sha to replace an existing file, so this
 * reads first. Reconnecting therefore rewrites rather than conflicting,
 * which is what makes "connect again with different settings" work.
 */
export async function writeWorkflowFile(
	config: GithubAppConfig,
	installationId: number,
	repoFullName: string,
	branch: string,
	yaml: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
	const token = await installationToken(config, installationId);
	if (!token) {
		return { ok: false, status: 409, error: 'the GitHub installation is no longer valid' };
	}

	const path = `/repos/${repoFullName}/contents/${WORKFLOW_FILENAME}`;
	const existing = await githubFetch(token, 'GET', `${path}?ref=${encodeURIComponent(branch)}`);
	const sha =
		existing.ok && typeof (existing.body as { sha?: string })?.sha === 'string'
			? (existing.body as { sha: string }).sha
			: undefined;

	const response = await githubFetch(token, 'PUT', path, {
		message: 'Add Cloudflarebase deploy workflow',
		content: btoa(yaml),
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
			error: `GitHub refused to write ${WORKFLOW_FILENAME}: ${error ?? 'permission denied'}. Grant the app Contents and Workflows write access on this repository.`
		};
	}
	return { ok: false, status: 502, error: error ?? 'GitHub refused to write the workflow' };
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
