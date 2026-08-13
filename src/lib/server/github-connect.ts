import * as Sentry from '@sentry/sveltekit';
import { isDemoProjectId } from '$lib/console';
import { getDb, type ControlPlaneDatabase } from '$lib/server/db';
import { githubConnection, githubInstallation, project } from '$lib/server/db/schema';
import { deployTokenCoversProject } from '$lib/server/hosting';
import { verifyOidcToken } from '$lib/server/github-oidc';
import { projectIdSchema } from '$lib/schemas/auth';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

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
	const rows = await db
		.select()
		.from(githubConnection)
		.where(eq(githubConnection.repoId, repoId));
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
