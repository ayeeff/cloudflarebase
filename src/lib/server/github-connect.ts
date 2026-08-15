import * as Sentry from '@sentry/sveltekit';
import { isDemoProjectId } from '$lib/console';
import { connectedWorkflowYaml } from '$lib/hosting-workflow';
import { getDb, type ControlPlaneDatabase } from '$lib/server/db';
import { githubConnection, githubInstallation, project } from '$lib/server/db/schema';
import { forgetInstallationToken, githubAppConfig, REPO_FULL_NAME } from '$lib/server/github';
import { verifyOidcToken } from '$lib/server/github-oidc';
import {
	deleteWorkflowFile,
	listInstallationRepos,
	repoHasWranglerConfig,
	writeRepoFile,
	writeWorkflowFile
} from '$lib/server/github-repo';
import { wranglerConfigJsonc, WRANGLER_TEMPLATES } from '$lib/server/frameworks';
import { appNameSchema, deployTokenCoversProject, resolveAppClaim } from '$lib/server/hosting';
import { projectIdSchema } from '$lib/schemas/auth';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';

/**
 * Connections between a GitHub repository and a project+app, and the trust
 * decision that turns an Actions OIDC token into permission to deploy.
 *
 * A connection is minted on a ROOT project and covers its branches, exactly
 * like a deploy token: the repository is the credential's subject, and which
 * branch of it deploys where is decided per push.
 */

export type ConnectionMode = 'build' | 'direct';

export interface Connection {
	id: string;
	projectId: string;
	appName: string;
	installationId: number;
	repoId: number;
	repoFullName: string;
	defaultBranch: string;
	mode: ConnectionMode;
	assetsDir: string | null;
	buildCommand: string | null;
	rootDir: string | null;
	createdAt: string;
	lastEventAt: string | null;
}

function toConnection(row: typeof githubConnection.$inferSelect): Connection {
	return {
		id: row.id,
		projectId: row.projectId,
		appName: row.appName,
		installationId: row.installationId,
		repoId: row.repoId,
		repoFullName: row.repoFullName,
		defaultBranch: row.defaultBranch,
		mode: row.mode,
		assetsDir: row.assetsDir,
		buildCommand: row.buildCommand,
		rootDir: row.rootDir,
		createdAt: row.createdAt.toISOString(),
		lastEventAt: row.lastEventAt?.toISOString() ?? null
	};
}

/** A root's connections, oldest first (one per app, at most two). */
export async function listConnections(
	platform: App.Platform | undefined,
	projectId: string
): Promise<Connection[]> {
	const db = await getDb(platform);
	const rows = await db
		.select()
		.from(githubConnection)
		.where(eq(githubConnection.projectId, projectId))
		.orderBy(asc(githubConnection.createdAt));
	return rows.map(toConnection);
}

export async function getConnection(
	platform: App.Platform | undefined,
	projectId: string,
	appName: string
): Promise<Connection | null> {
	const db = await getDb(platform);
	const [row] = await db
		.select()
		.from(githubConnection)
		.where(and(eq(githubConnection.projectId, projectId), eq(githubConnection.appName, appName)))
		.limit(1);
	return row ? toConnection(row) : null;
}

/**
 * Every connection for a repository. Deliberately many: the same repo
 * legitimately deploys to more than one project, and a push fans out to all
 * of them rather than picking one arbitrarily.
 */
export async function getConnectionsByRepo(
	platform: App.Platform | undefined,
	repoId: number
): Promise<Connection[]> {
	const db = await getDb(platform);
	const rows = await db.select().from(githubConnection).where(eq(githubConnection.repoId, repoId));
	return rows.map(toConnection);
}

export interface SaveConnectionInput {
	projectId: string;
	appName: string;
	installationId: number;
	repoId: number;
	repoFullName: string;
	defaultBranch: string;
	mode: ConnectionMode;
	assetsDir: string | null;
	buildCommand: string | null;
	rootDir: string | null;
}

/** Upserts the connection for a project+app - reconnecting replaces. */
export async function saveConnection(
	platform: App.Platform | undefined,
	input: SaveConnectionInput
): Promise<Connection> {
	const db = await getDb(platform);
	await db
		.delete(githubConnection)
		.where(
			and(
				eq(githubConnection.projectId, input.projectId),
				eq(githubConnection.appName, input.appName)
			)
		);
	const [created] = await db
		.insert(githubConnection)
		.values({ id: crypto.randomUUID(), ...input, createdAt: new Date() })
		.returning();
	return toConnection(created);
}

export async function deleteConnection(
	platform: App.Platform | undefined,
	projectId: string,
	appName: string
): Promise<boolean> {
	const db = await getDb(platform);
	const deleted = await db
		.delete(githubConnection)
		.where(and(eq(githubConnection.projectId, projectId), eq(githubConnection.appName, appName)))
		.returning();
	return deleted.length > 0;
}

/** Stamps the last accepted push, for the Hosting page. Best effort. */
export async function touchConnection(
	platform: App.Platform | undefined,
	id: string,
	repoFullName: string
): Promise<void> {
	try {
		const db = await getDb(platform);
		// Re-syncing the name on every push is what keeps build-mode OIDC
		// matching working across a repository rename.
		await db
			.update(githubConnection)
			.set({ lastEventAt: new Date(), repoFullName })
			.where(eq(githubConnection.id, id));
	} catch {
		// cosmetic
	}
}

/** Part of project deletion - takes the caller's handle, like the claims. */
export async function releaseGithubRows(
	db: ControlPlaneDatabase,
	projectIds: string[]
): Promise<void> {
	if (!projectIds.length) return;
	await db.delete(githubConnection).where(inArray(githubConnection.projectId, projectIds));
}

// --- Installations ---------------------------------------------------------

/**
 * Records the operator/org an installation belongs to. Called ONLY from the
 * install callback, after the signed state verified that this operator
 * started this install - that is the moment the id is trustworthy.
 */
export async function recordInstallation(
	platform: App.Platform | undefined,
	input: { installationId: number; orgId: string | null; accountLogin: string; userId: string }
): Promise<void> {
	const db = await getDb(platform);
	await db
		.insert(githubInstallation)
		.values({
			id: input.installationId,
			orgId: input.orgId,
			accountLogin: input.accountLogin,
			installedBy: input.userId,
			createdAt: new Date()
		})
		.onConflictDoUpdate({
			target: githubInstallation.id,
			set: { orgId: input.orgId, accountLogin: input.accountLogin, installedBy: input.userId }
		});
}

/**
 * Whether an installation may be used for a project: the org that installed
 * it must own the project. Both-null matches, which is the legacy/self-hosted
 * case where a project is already visible to every operator.
 */
export async function installationCoversProject(
	platform: App.Platform | undefined,
	installationId: number,
	projectId: string
): Promise<{ ok: true; accountLogin: string } | { ok: false; error: string }> {
	const db = await getDb(platform);
	const [installation] = await db
		.select()
		.from(githubInstallation)
		.where(eq(githubInstallation.id, installationId))
		.limit(1);
	if (!installation) {
		return { ok: false, error: 'that GitHub installation is not connected to this console' };
	}
	const [row] = await db.select().from(project).where(eq(project.id, projectId)).limit(1);
	if (!row) return { ok: false, error: 'no such project' };
	if ((installation.orgId ?? null) !== (row.orgId ?? null)) {
		return { ok: false, error: 'that GitHub installation belongs to another organization' };
	}
	return { ok: true, accountLogin: installation.accountLogin };
}

/**
 * Drops an installation and every connection riding it - what an
 * `installation.deleted` webhook means. The connections are dead the moment
 * the installation is: no token can be minted for it again.
 */
export async function forgetInstallation(
	platform: App.Platform | undefined,
	installationId: number
): Promise<void> {
	const db = await getDb(platform);
	await db.delete(githubConnection).where(eq(githubConnection.installationId, installationId));
	await db.delete(githubInstallation).where(eq(githubInstallation.id, installationId));
	forgetInstallationToken(installationId);
}

export async function listInstallationsForOrg(
	platform: App.Platform | undefined,
	orgId: string | null
): Promise<{ id: number; accountLogin: string }[]> {
	const db = await getDb(platform);
	const rows = await db
		.select()
		.from(githubInstallation)
		.where(orgId === null ? isNull(githubInstallation.orgId) : eq(githubInstallation.orgId, orgId));
	return rows.map((row) => ({ id: row.id, accountLogin: row.accountLogin }));
}

// --- Connecting ------------------------------------------------------------

/** A repo-relative directory: no absolute paths, no traversal, no drive.
 * Charset-limited because build-mode values are embedded into the workflow
 * YAML (as CLOUDFLAREBASE_ASSETS) - quoting is a bug class, refusing is not. */
const assetsDirSchema = z
	.string()
	.max(200)
	.regex(/^[A-Za-z0-9._/-]*$/, 'assets directory has unsupported characters')
	.refine((value) => !value.startsWith('/') && !value.split('/').includes('..'), {
		message: 'assets directory must be a path inside the repository'
	});

/** One shell line for the workflow's build step. Single-line keeps the YAML
 * block-scalar embedding trivially safe; chains use `&&` like anywhere else.
 * The operator can only ever mangle their OWN repository's workflow - the
 * file is committed there, where they could edit it directly anyway. */
const buildCommandSchema = z
	.string()
	.trim()
	.min(1)
	.max(300)
	.regex(/^[^\r\n]+$/, 'the build command must be a single line');

export const connectSchema = z.object({
	installationId: z.number().int().positive(),
	repoFullName: z.string().regex(REPO_FULL_NAME, 'expected owner/repository'),
	appName: appNameSchema,
	mode: z.enum(['build', 'direct']),
	/** Direct: the directory published as-is. Build: where the build lands,
	 * relative to rootDir. */
	assetsDir: assetsDirSchema.optional(),
	buildCommand: buildCommandSchema.optional(),
	/** Monorepo root - install, build, and deploy run here (build mode). */
	rootDir: assetsDirSchema.optional(),
	/** From the inspection; decides the workflow's install steps. */
	packageManager: z.enum(['npm', 'pnpm', 'yarn', 'bun']).optional(),
	/** Which known wrangler.jsonc to commit for a repo that has none. An id
	 * into WRANGLER_TEMPLATES - the server owns the file content. */
	wranglerTemplate: z
		.enum(Object.keys(WRANGLER_TEMPLATES) as [keyof typeof WRANGLER_TEMPLATES])
		.optional()
});

export type ConnectResult =
	| {
			ok: true;
			connection: Connection;
			subdomain: string;
			workflowWritten: boolean;
			wranglerWritten: boolean;
	  }
	| { ok: false; status: number; error: string };

/**
 * Connects a repository to a project+app.
 *
 * Order matters: the subdomain claim is resolved BEFORE anything is written
 * to GitHub, so a workflow never lands in someone's repository pointing at an
 * app that could not be claimed. Build mode then writes the workflow; direct
 * mode writes nothing at all - the repository is left exactly as it was and
 * the push webhook does the work.
 */
export async function connectRepository(
	platform: App.Platform | undefined,
	projectId: string,
	input: unknown,
	origin: string
): Promise<ConnectResult> {
	if (isDemoProjectId(projectId)) {
		return { ok: false, status: 403, error: 'demo projects cannot deploy apps' };
	}
	const config = githubAppConfig(platform);
	if (!config) {
		return { ok: false, status: 503, error: 'no GitHub App is configured on this console' };
	}
	const parsed = connectSchema.safeParse(input);
	if (!parsed.success) {
		return { ok: false, status: 400, error: parsed.error.issues[0]?.message ?? 'invalid request' };
	}
	const { installationId, repoFullName, appName, mode } = parsed.data;

	const db = await getDb(platform);
	const [row] = await db.select().from(project).where(eq(project.id, projectId)).limit(1);
	if (!row) return { ok: false, status: 404, error: 'no such project' };
	if (row.parentId) {
		// One connection covers the root and every branch - a push to a git
		// branch deploys `<root>--<branch>` without a second connection.
		return { ok: false, status: 400, error: 'connect repositories on the root project' };
	}

	const covers = await installationCoversProject(platform, installationId, projectId);
	if (!covers.ok) return { ok: false, status: 403, error: covers.error };

	// Never trust the caller's view of the repository: re-read it from the
	// installation, which is also what proves the installation can see it.
	const repos = await listInstallationRepos(config, installationId);
	if (!repos) {
		return {
			ok: false,
			status: 409,
			error: 'the GitHub installation is no longer valid - reinstall the app'
		};
	}
	const repo = repos.find((candidate) => candidate.fullName === repoFullName);
	if (!repo) {
		return { ok: false, status: 404, error: 'that repository is not in this installation' };
	}

	// Claim first: a workflow committed for an unclaimable app would deploy
	// into a 404 on every future push.
	const claim = await resolveAppClaim(platform, projectId, appName);
	if (!claim.ok) return { ok: false, status: claim.status, error: claim.error };

	// The framework preset travels INTO the workflow at write time; the CLI
	// reads CLOUDFLAREBASE_ASSETS back out, so reconnecting with different
	// settings is a rewrite, never a migration.
	const buildCommand = mode === 'build' ? (parsed.data.buildCommand ?? null) : null;
	const outputDir = mode === 'build' ? parsed.data.assetsDir?.trim() || null : null;
	const rootDir =
		mode === 'build' ? parsed.data.rootDir?.trim().replace(/^\/+|\/+$/g, '') || null : null;

	// The wrangler config lands FIRST: committing the workflow triggers a
	// push event on itself, and that very first run must already find the
	// config it builds against. Never overwrites - the repo is re-checked
	// here because the inspection's answer is a client round trip old, and
	// an unanswerable check counts as "exists" for the same reason.
	let wranglerWritten = false;
	if (mode === 'build' && parsed.data.wranglerTemplate) {
		const exists = await repoHasWranglerConfig(
			config,
			installationId,
			repo.fullName,
			repo.defaultBranch,
			rootDir
		);
		if (exists === false) {
			const written = await writeRepoFile(
				config,
				installationId,
				repo.fullName,
				repo.defaultBranch,
				`${rootDir ? `${rootDir}/` : ''}wrangler.jsonc`,
				wranglerConfigJsonc(parsed.data.wranglerTemplate, claim.appName),
				'Add wrangler.jsonc for the Cloudflare build'
			);
			if (!written.ok) return { ok: false, status: written.status, error: written.error };
			wranglerWritten = true;
		}
	}

	let workflowWritten = false;
	if (mode === 'build') {
		const written = await writeWorkflowFile(
			config,
			installationId,
			repo.fullName,
			repo.defaultBranch,
			connectedWorkflowYaml({
				origin,
				projectId,
				appName: claim.appName,
				packageManager: parsed.data.packageManager,
				buildCommand,
				outputDir,
				rootDir
			})
		);
		if (!written.ok) return { ok: false, status: written.status, error: written.error };
		workflowWritten = true;
	}

	const connection = await saveConnection(platform, {
		projectId,
		appName: claim.appName,
		installationId,
		repoId: repo.id,
		repoFullName: repo.fullName,
		defaultBranch: repo.defaultBranch,
		mode,
		// Direct publishes this directory from every push; build records where
		// the build lands (null = the CLI autodetects at deploy time).
		assetsDir: mode === 'direct' ? (parsed.data.assetsDir ?? '') : outputDir,
		buildCommand,
		rootDir
	});
	return { ok: true, connection, subdomain: claim.subdomain, workflowWritten, wranglerWritten };
}

/**
 * Drops a connection, and removes the workflow it wrote. Removing the file is
 * best effort but deliberate: connect created it, so disconnect should not
 * leave the repository failing CI on every push forever.
 */
export async function disconnectRepository(
	platform: App.Platform | undefined,
	projectId: string,
	appName: string
): Promise<{ ok: boolean; workflowRemoved: boolean }> {
	const connection = await getConnection(platform, projectId, appName);
	if (!connection) return { ok: false, workflowRemoved: false };

	let workflowRemoved = false;
	const config = githubAppConfig(platform);
	if (config && connection.mode === 'build') {
		workflowRemoved = await deleteWorkflowFile(
			config,
			connection.installationId,
			connection.repoFullName,
			connection.defaultBranch
		);
	}
	return { ok: await deleteConnection(platform, projectId, appName), workflowRemoved };
}

// --- The deploy grant ------------------------------------------------------

export interface GithubDeployGrant {
	/** The ROOT project the connection was made on. */
	projectId: string;
	appName: string;
	repoFullName: string;
	ref: string;
	sha: string;
}

/**
 * Turns an Actions OIDC bearer into permission to deploy `targetProjectId`.
 *
 * Two independent checks, and both must hold: GitHub's signature proves which
 * REPOSITORY is calling, and our connection table says which PROJECT that
 * repository may deploy to. A verified token for an unconnected repo grants
 * nothing, which is what keeps the trust anchored in the console rather than
 * in whoever can run a workflow.
 *
 * `direct`-mode connections are excluded on purpose: they deploy from the
 * webhook and never present a token, so accepting one would be a second,
 * unaudited path into the same app.
 */
export async function verifyGithubDeployGrant(
	platform: App.Platform | undefined,
	token: string,
	audience: string,
	targetProjectId: string
): Promise<GithubDeployGrant | null> {
	if (!projectIdSchema.safeParse(targetProjectId).success) return null;
	if (isDemoProjectId(targetProjectId)) return null;
	try {
		const claims = await verifyOidcToken(token, audience);
		if (!claims) return null;

		const connections = await getConnectionsByRepo(platform, claims.repositoryId);
		for (const connection of connections) {
			if (connection.mode !== 'build') continue;
			// The name is re-synced on every webhook; a mismatch here means the
			// repo was renamed with no push since, so compare on id (already
			// matched by the lookup) and keep the claim check as a tripwire.
			if (connection.repoFullName !== claims.repository) {
				console.warn(
					`github oidc: repo ${claims.repositoryId} is ${claims.repository}, connection says ${connection.repoFullName}`
				);
			}
			if (!(await deployTokenCoversProject(platform, connection.projectId, targetProjectId))) {
				continue;
			}
			return {
				projectId: connection.projectId,
				appName: connection.appName,
				repoFullName: claims.repository,
				ref: claims.ref,
				sha: claims.sha
			};
		}
		return null;
	} catch (cause) {
		console.error('github deploy grant failed', cause);
		Sentry.captureException(cause, { level: 'error', tags: { operation: 'github-deploy-grant' } });
		return null;
	}
}
