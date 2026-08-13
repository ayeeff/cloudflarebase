import * as Sentry from '@sentry/sveltekit';
import { AGENT_REGISTRY } from '$lib/agent-registry';
import { requireAgent } from '$lib/server/agents';
import { githubAppConfig } from '$lib/server/github';
import { getConnectionsByRepo, touchConnection, type Connection } from '$lib/server/github-connect';
import { repoTarballUrl } from '$lib/server/github-repo';
import { resolveAppClaim } from '$lib/server/hosting';
import { branchNameSchema, createBranch, getProjectOwnership } from '$lib/server/registry';

/**
 * What a verified push does (docs/managed-service-design.md, Phase B).
 *
 * Only `direct` connections are acted on here. A `build` connection's
 * repository deploys itself through the Actions workflow - GitHub already
 * triggers on push, so doing anything here would be a second deploy of the
 * same commit.
 */

/** The slice of GitHub's push payload we act on. */
export interface PushPayload {
	ref?: string;
	after?: string;
	deleted?: boolean;
	repository?: { id?: number; full_name?: string; default_branch?: string };
	installation?: { id?: number };
}

export interface PushOutcome {
	appName: string;
	projectId: string;
	status: 'deployed' | 'skipped' | 'failed';
	detail: string;
}

/**
 * Git branch -> cloudflarebase branch name. Mirrors the CLI's
 * `sanitizeBranchName`: the charset is narrower than git's, so `feat/Login`
 * becomes `feat-login`. Null when nothing valid survives.
 */
export function sanitizeBranchName(branch: string): string | null {
	const cleaned = branch
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/-{2,}/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 16)
		.replace(/-+$/, '');
	return branchNameSchema.safeParse(cleaned).success ? cleaned : null;
}

/**
 * Resolves the project a pushed ref deploys to, creating the branch row when
 * a new git branch appears. The default branch is the ROOT project - `main`
 * never becomes a branch id, because it aliases the root everywhere.
 */
async function resolveTarget(
	platform: App.Platform | undefined,
	connection: Connection,
	branch: string,
	defaultBranch: string
): Promise<{ ok: true; projectId: string } | { ok: false; detail: string }> {
	if (branch === defaultBranch) return { ok: true, projectId: connection.projectId };

	const name = sanitizeBranchName(branch);
	if (!name || name === 'main') {
		return { ok: false, detail: `branch "${branch}" has no valid cloudflarebase name` };
	}
	const projectId = `${connection.projectId}--${name}`;

	const ownership = await getProjectOwnership(platform, projectId);
	if (ownership.registered) return { ok: true, projectId };

	const created = await createBranch(platform, connection.projectId, { branch: name });
	if (!created.ok) {
		// The branch ceiling is the usual cause, and it is a real answer: the
		// push is reported as skipped rather than retried forever.
		return { ok: false, detail: created.error };
	}
	return { ok: true, projectId };
}

/**
 * Deploys one direct-mode connection for a pushed commit.
 *
 * The order mirrors the console's own deploy route: claim the subdomain,
 * push the claim to the agent, then hand over the work. The agent can only
 * ever deploy to a subdomain recorded for that project.
 */
async function deployConnection(
	platform: App.Platform | undefined,
	connection: Connection,
	payload: Required<Pick<PushPayload, 'after'>> & { branch: string; defaultBranch: string },
	origin: string
): Promise<PushOutcome> {
	const base = { appName: connection.appName, projectId: connection.projectId };
	const config = githubAppConfig(platform);
	if (!config) return { ...base, status: 'failed', detail: 'no GitHub App is configured' };

	const target = await resolveTarget(platform, connection, payload.branch, payload.defaultBranch);
	if (!target.ok) return { ...base, status: 'skipped', detail: target.detail };

	const claim = await resolveAppClaim(platform, target.projectId, connection.appName);
	if (!claim.ok) {
		return { ...base, projectId: target.projectId, status: 'failed', detail: claim.error };
	}

	// Resolved here so the installation token never leaves the control plane -
	// the agent receives a signed, short-lived URL it can fetch anonymously.
	const tarballUrl = await repoTarballUrl(
		config,
		connection.installationId,
		connection.repoFullName,
		payload.after
	);
	if (!tarballUrl) {
		return {
			...base,
			projectId: target.projectId,
			status: 'failed',
			detail: 'could not resolve the repository archive - is the installation still valid?'
		};
	}

	const entry = AGENT_REGISTRY.hosting;
	const agent = requireAgent(platform, entry);
	const worker = entry.manifest.worker;
	const project = encodeURIComponent(target.projectId);
	const app = encodeURIComponent(claim.appName);

	const push = await agent.fetch(`https://${worker}/internal/projects/${project}/apps/${app}`, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ subdomain: claim.subdomain })
	});
	if (!push.ok) {
		return {
			...base,
			projectId: target.projectId,
			status: 'failed',
			detail: 'the hosting agent refused the app'
		};
	}

	const deployed = await agent.fetch(
		`https://${worker}/internal/projects/${project}/apps/${app}/git-deploy`,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ tarballUrl, assetsDir: connection.assetsDir ?? '', origin })
		}
	);
	const body = (await (deployed as unknown as Response).json().catch(() => null)) as {
		error?: string;
		url?: string;
	} | null;
	if (!deployed.ok) {
		return {
			...base,
			projectId: target.projectId,
			status: 'failed',
			detail: body?.error ?? 'the deploy failed'
		};
	}

	await touchConnection(platform, connection.id, connection.repoFullName);
	return {
		...base,
		projectId: target.projectId,
		status: 'deployed',
		detail: body?.url ?? claim.subdomain
	};
}

/**
 * Handles a verified push. Never throws: a webhook that 500s gets redelivered
 * by GitHub, and a deploy that failed for a real reason (a full branch quota,
 * an empty output directory) would fail identically every time.
 */
export async function handlePush(
	platform: App.Platform | undefined,
	payload: PushPayload,
	origin: string
): Promise<PushOutcome[]> {
	const ref = payload.ref ?? '';
	const sha = payload.after ?? '';
	const repoId = payload.repository?.id;
	const defaultBranch = payload.repository?.default_branch ?? 'main';

	// Tags and branch deletions are not deploys. An all-zero `after` is how a
	// delete looks when `deleted` is absent.
	if (!ref.startsWith('refs/heads/') || !repoId || payload.deleted || /^0+$/.test(sha)) {
		return [];
	}

	const branch = ref.slice('refs/heads/'.length);
	const connections = await getConnectionsByRepo(platform, repoId);
	const outcomes: PushOutcome[] = [];

	for (const connection of connections) {
		if (connection.mode !== 'direct') {
			// Build mode deploys itself through the workflow in the repository.
			outcomes.push({
				appName: connection.appName,
				projectId: connection.projectId,
				status: 'skipped',
				detail: 'build mode - GitHub Actions deploys this repository'
			});
			continue;
		}
		try {
			outcomes.push(
				await deployConnection(platform, connection, { after: sha, branch, defaultBranch }, origin)
			);
		} catch (cause) {
			console.error('github push deploy failed', connection.repoFullName, cause);
			Sentry.captureException(cause, {
				level: 'error',
				tags: { operation: 'github-push-deploy', projectId: connection.projectId }
			});
			outcomes.push({
				appName: connection.appName,
				projectId: connection.projectId,
				status: 'failed',
				detail: 'the deploy could not be completed'
			});
		}
	}

	return outcomes;
}
