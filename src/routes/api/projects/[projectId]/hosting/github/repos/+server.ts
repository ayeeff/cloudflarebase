import { assertProjectId } from '$lib/server/agents';
import { githubAppConfig } from '$lib/server/github';
import { installationCoversProject, reportInstallationFailure } from '$lib/server/github-connect';
import { inspectRepo, listInstallationRepos } from '$lib/server/github-repo';
import type { RequestHandler } from './$types';

/**
 * The repository picker's data. Scoped twice: the installation must belong to
 * the org that owns this project, and the installation token itself only
 * reaches repositories the operator selected on GitHub.
 *
 * With `?repo=<owner>/<name>` it also inspects that repository and reports
 * whether it needs a runner - which is what preselects build or direct mode.
 */
export const GET: RequestHandler = async ({ params, url, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const config = githubAppConfig(platform);
	if (!config) {
		return Response.json({ error: 'no GitHub App is configured on this console' }, { status: 503 });
	}

	const installationId = Number(url.searchParams.get('installation'));
	if (!Number.isSafeInteger(installationId) || installationId <= 0) {
		return Response.json({ error: 'installation is required' }, { status: 400 });
	}
	const covers = await installationCoversProject(platform, installationId, projectId);
	if (!covers.ok) {
		return Response.json({ error: covers.error }, { status: 403 });
	}

	const listed = await listInstallationRepos(config, installationId);
	if (listed.repos === null) {
		const answer = await reportInstallationFailure(platform, installationId, listed);
		return Response.json(answer.body, { status: answer.status });
	}
	const repos = listed.repos;

	const wanted = url.searchParams.get('repo');
	if (!wanted) return Response.json({ repos });

	const repo = repos.find((candidate) => candidate.fullName === wanted);
	if (!repo) {
		return Response.json({ error: 'that repository is not in this installation' }, { status: 404 });
	}
	// Optional monorepo root: inspection reads THAT directory's package.json
	// and listing, so the presets describe the app, not the workspace shell.
	const dir = url.searchParams.get('dir')?.trim() ?? '';
	if (dir && !/^[A-Za-z0-9._/-]{1,200}$/.test(dir)) {
		return Response.json({ error: 'invalid root directory' }, { status: 400 });
	}
	if (dir.startsWith('/') || dir.split('/').includes('..')) {
		return Response.json({ error: 'invalid root directory' }, { status: 400 });
	}
	return Response.json({
		repos,
		inspection: await inspectRepo(
			config,
			installationId,
			repo.fullName,
			repo.defaultBranch,
			dir || null
		)
	});
};
