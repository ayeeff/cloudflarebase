import * as Sentry from '@sentry/sveltekit';
import { isDemoProjectId } from '$lib/console';
import { getDb, type ControlPlaneDatabase } from '$lib/server/db';
import { app, deployToken, project } from '$lib/server/db/schema';
import { projectIdSchema } from '$lib/schemas/auth';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

/**
 * Hosting control plane (docs/managed-service-design.md, Phase B): subdomain
 * claims on the global `*.cfbase.dev` namespace, and project-scoped deploy
 * tokens. Both live HERE and not in the hosting agent because they are
 * installation-wide state - the agent contract's rule that no agent owns
 * global state. The HostingAgent only ever receives an already-resolved
 * subdomain.
 */

/** Never dispatched, never claimable - platform surfaces and likely lures. */
export const RESERVED_SUBDOMAINS = new Set([
	'www',
	'api',
	'app',
	'apps',
	'console',
	'dashboard',
	'admin',
	'docs',
	'blog',
	'status',
	'mail',
	'email',
	'smtp',
	'ns1',
	'ns2',
	'cfbase',
	'cloudflarebase',
	'auth',
	'db',
	'hosting',
	'demo',
	'preview',
	'staging',
	'support',
	'help',
	'login',
	'signup'
]);

/** App names: subdomain charset, 3-48 chars, no `--`, not a reserved name. */
export const appNameSchema = z
	.string()
	.regex(
		/^[a-z0-9][a-z0-9-]{2,47}$/,
		'Use 3-48 lowercase letters, numbers, and hyphens, starting with a letter or number.'
	)
	.refine((value) => !value.includes('--'), 'app names may not contain "--"')
	.refine((value) => !value.endsWith('-'), 'app names may not end with a hyphen')
	.refine((value) => !RESERVED_SUBDOMAINS.has(value), 'that name is reserved');

/** Deploy-token secret shape: `cfbd_` + 32 random bytes hex. */
export const DEPLOY_TOKEN_PATTERN = /^cfbd_[0-9a-f]{64}$/;

const MAX_APPS_PER_PROJECT = 2;
const MAX_DEPLOY_TOKENS_PER_PROJECT = 10;
/** How far auto-numbering searches before giving up (squatting backstop). */
const MAX_AUTO_NUMBER = 50;
/** DNS label ceiling - `<app>-<branch>-<n>` must stay a valid hostname. */
const MAX_SUBDOMAIN_LENGTH = 63;

export type ClaimResult =
	| {
			ok: true;
			/** What was ACTUALLY claimed (or would be, on a dry run). */
			subdomain: string;
			appName: string;
			/** False when an existing claim row was reused, or on a dry run. */
			created: boolean;
	  }
	| { ok: false; status: number; error: string };

/**
 * Resolves the subdomain for a project+app, claiming it unless `dry`.
 *
 * The persisted row always wins: once a project+app has claimed a subdomain
 * it is reused verbatim forever - never re-derived - so URLs stay stable even
 * when neighboring claims appear or are released. Otherwise the wanted name
 * is `<app>` on a root and `<app>-<branch>` on a branch (single dash; `main`
 * never appears because it aliases the root and is a refused branch name),
 * and a taken name auto-numbers to the first free `<wanted>-2`, `-3`, ... -
 * collisions report what they claimed, they never fail. Any ambiguity between
 * an app named `x-2` and branch `2` of app `x` is resolved by this table,
 * never by parsing a subdomain.
 */
export async function resolveAppClaim(
	platform: App.Platform | undefined,
	projectId: string,
	input: unknown,
	options: { dry?: boolean } = {}
): Promise<ClaimResult> {
	if (!projectIdSchema.safeParse(projectId).success) {
		return { ok: false, status: 400, error: 'invalid project id' };
	}
	if (isDemoProjectId(projectId)) {
		// No demo hosting: anonymous code execution is an abuse machine. Demos
		// are throwaway - create a real project to deploy.
		return { ok: false, status: 403, error: 'demo projects cannot deploy apps' };
	}
	const parsedName = appNameSchema.safeParse(input);
	if (!parsedName.success) {
		return {
			ok: false,
			status: 400,
			error: parsedName.error.issues[0]?.message ?? 'invalid app name'
		};
	}
	const appName = parsedName.data;

	const db = await getDb(platform);
	const [row] = await db.select().from(project).where(eq(project.id, projectId)).limit(1);
	if (!row) return { ok: false, status: 404, error: 'no such project' };

	// The persisted claim wins - reused verbatim, never re-derived.
	const [existing] = await db
		.select()
		.from(app)
		.where(and(eq(app.projectId, projectId), eq(app.appName, appName)))
		.limit(1);
	if (existing) {
		return { ok: true, subdomain: existing.subdomain, appName, created: false };
	}

	const claimed = await db.select().from(app).where(eq(app.projectId, projectId));
	if (claimed.length >= MAX_APPS_PER_PROJECT) {
		return {
			ok: false,
			status: 409,
			error: `projects are limited to ${MAX_APPS_PER_PROJECT} apps`
		};
	}

	const wanted = row.branchName ? `${appName}-${row.branchName}` : appName;
	if (wanted.length > MAX_SUBDOMAIN_LENGTH) {
		return {
			ok: false,
			status: 400,
			error: 'the app plus branch name exceeds 63 characters - use a shorter app name'
		};
	}

	for (let n = 1; n <= MAX_AUTO_NUMBER; n += 1) {
		const candidate = n === 1 ? wanted : `${wanted}-${n}`;
		if (candidate.length > MAX_SUBDOMAIN_LENGTH || RESERVED_SUBDOMAINS.has(candidate)) continue;
		if (options.dry) {
			const [taken] = await db.select().from(app).where(eq(app.subdomain, candidate)).limit(1);
			if (taken) continue;
			return { ok: true, subdomain: candidate, appName, created: false };
		}
		// PK atomicity is the arbiter: the loser's insert affects nothing and the
		// loop moves to the next number - a concurrent claim can never fail, only
		// land one number higher.
		const [created] = await db
			.insert(app)
			.values({ subdomain: candidate, projectId, appName, createdAt: new Date() })
			.onConflictDoNothing()
			.returning();
		if (created) {
			return { ok: true, subdomain: created.subdomain, appName, created: true };
		}
	}

	return { ok: false, status: 409, error: 'no free subdomain within the numbering range' };
}

/** A project's claim rows, oldest first (the Hosting page's app list). */
export async function listAppClaims(
	platform: App.Platform | undefined,
	projectId: string
): Promise<{ subdomain: string; appName: string; createdAt: string }[]> {
	const db = await getDb(platform);
	const rows = await db
		.select()
		.from(app)
		.where(eq(app.projectId, projectId))
		.orderBy(asc(app.createdAt));
	return rows.map((row) => ({
		subdomain: row.subdomain,
		appName: row.appName,
		createdAt: row.createdAt.toISOString()
	}));
}

/**
 * Releases ONE app's subdomain claim. Called only after the agent confirmed
 * the erase - freeing a name whose script still serves would hand the
 * subdomain to the next claimant while the old tenant's code answers on it.
 */
export async function releaseAppClaim(
	platform: App.Platform | undefined,
	projectId: string,
	appName: string
): Promise<boolean> {
	const db = await getDb(platform);
	const deleted = await db
		.delete(app)
		.where(and(eq(app.projectId, projectId), eq(app.appName, appName)))
		.returning();
	return deleted.length > 0;
}

/**
 * Releases a project's hosting rows - its subdomain claims and any deploy
 * tokens minted on it. Part of project deletion; takes the caller's handle
 * because it runs inside the registry's delete flow.
 */
export async function releaseHostingRows(
	db: ControlPlaneDatabase,
	projectIds: string[]
): Promise<void> {
	if (!projectIds.length) return;
	await db.delete(app).where(inArray(app.projectId, projectIds));
	await db.delete(deployToken).where(inArray(deployToken.projectId, projectIds));
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const mintDeployTokenSchema = z.object({
	name: z.string().trim().min(1, 'name is required').max(64)
});

export type MintTokenResult =
	| { ok: true; id: string; name: string; token: string; createdAt: string }
	| { ok: false; status: number; error: string };

/**
 * Mints a deploy token on a ROOT project. The secret is returned exactly once;
 * only its SHA-256 digest is stored, so a control-plane leak never yields a
 * working credential.
 */
export async function mintDeployToken(
	platform: App.Platform | undefined,
	projectId: string,
	input: unknown
): Promise<MintTokenResult> {
	if (!projectIdSchema.safeParse(projectId).success) {
		return { ok: false, status: 400, error: 'invalid project id' };
	}
	if (isDemoProjectId(projectId)) {
		return { ok: false, status: 403, error: 'demo projects cannot deploy apps' };
	}
	const parsed = mintDeployTokenSchema.safeParse(input);
	if (!parsed.success) {
		return { ok: false, status: 400, error: parsed.error.issues[0]?.message ?? 'invalid token' };
	}

	const db = await getDb(platform);
	const [row] = await db.select().from(project).where(eq(project.id, projectId)).limit(1);
	if (!row) return { ok: false, status: 404, error: 'no such project' };
	if (row.parentId) {
		// A token covers the root and all its branches - minted once, on the root.
		return { ok: false, status: 400, error: 'mint deploy tokens on the root project' };
	}

	const existing = await db
		.select({ id: deployToken.id })
		.from(deployToken)
		.where(eq(deployToken.projectId, projectId));
	if (existing.length >= MAX_DEPLOY_TOKENS_PER_PROJECT) {
		return {
			ok: false,
			status: 409,
			error: `projects are limited to ${MAX_DEPLOY_TOKENS_PER_PROJECT} deploy tokens`
		};
	}

	const secretBytes = crypto.getRandomValues(new Uint8Array(32));
	const secret = `cfbd_${[...secretBytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
	const [created] = await db
		.insert(deployToken)
		.values({
			id: crypto.randomUUID(),
			projectId,
			name: parsed.data.name,
			tokenHash: await sha256Hex(secret),
			createdAt: new Date()
		})
		.returning();

	return {
		ok: true,
		id: created.id,
		name: created.name,
		token: secret,
		createdAt: created.createdAt.toISOString()
	};
}

/** A root's tokens - metadata only, the secret is unrecoverable by design. */
export async function listDeployTokens(
	platform: App.Platform | undefined,
	projectId: string
): Promise<{ id: string; name: string; createdAt: string; lastUsedAt: string | null }[]> {
	const db = await getDb(platform);
	const rows = await db
		.select()
		.from(deployToken)
		.where(eq(deployToken.projectId, projectId))
		.orderBy(asc(deployToken.createdAt));
	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		createdAt: row.createdAt.toISOString(),
		lastUsedAt: row.lastUsedAt?.toISOString() ?? null
	}));
}

/** Revocation IS row deletion - a token that is not in the table is dead. */
export async function revokeDeployToken(
	platform: App.Platform | undefined,
	projectId: string,
	tokenId: string
): Promise<boolean> {
	const db = await getDb(platform);
	const deleted = await db
		.delete(deployToken)
		.where(and(eq(deployToken.id, tokenId), eq(deployToken.projectId, projectId)))
		.returning();
	return deleted.length > 0;
}

export interface DeployTokenGrant {
	/** The ROOT project the token was minted on. */
	projectId: string;
	tokenId: string;
}

/**
 * Verifies a `cfbd_` bearer against the stored digests. Null on any failure -
 * the guard turns that into a plain 401, never a session fallback. The
 * last-used stamp is best-effort; verification must not depend on a write.
 */
export async function verifyDeployToken(
	platform: App.Platform | undefined,
	secret: string
): Promise<DeployTokenGrant | null> {
	if (!DEPLOY_TOKEN_PATTERN.test(secret)) return null;
	try {
		const db = await getDb(platform);
		const [row] = await db
			.select()
			.from(deployToken)
			.where(eq(deployToken.tokenHash, await sha256Hex(secret)))
			.limit(1);
		if (!row) return null;
		try {
			await db
				.update(deployToken)
				.set({ lastUsedAt: new Date() })
				.where(eq(deployToken.id, row.id));
		} catch {
			// the stamp is cosmetic
		}
		return { projectId: row.projectId, tokenId: row.id };
	} catch (cause) {
		console.error('deploy token verification failed', cause);
		Sentry.captureException(cause, { level: 'error', tags: { operation: 'verify-deploy-token' } });
		return null;
	}
}

/**
 * Whether a token minted on `tokenProjectId` covers `targetProjectId`: the
 * root itself, or a registered branch of it. The registry decides - never the
 * string shape.
 */
export async function deployTokenCoversProject(
	platform: App.Platform | undefined,
	tokenProjectId: string,
	targetProjectId: string
): Promise<boolean> {
	if (tokenProjectId === targetProjectId) return true;
	if (!projectIdSchema.safeParse(targetProjectId).success) return false;
	try {
		const db = await getDb(platform);
		const [row] = await db
			.select({ parentId: project.parentId })
			.from(project)
			.where(eq(project.id, targetProjectId))
			.limit(1);
		return row?.parentId === tokenProjectId;
	} catch {
		// Fail closed: a deploy credential must never widen during an outage.
		return false;
	}
}

/**
 * The ONLY surfaces a deploy token is accepted on: the deploy endpoint and
 * branch creation (CI auto-creating the row for a new git branch). Everything
 * else answers 401 - a deploy token is never a session.
 */
export function isDeployTokenSurface(pathname: string, method: string): boolean {
	if (method !== 'POST') return false;
	return (
		/^\/api\/projects\/[^/]+\/hosting\/apps\/[^/]+\/deploys$/.test(pathname) ||
		/^\/api\/projects\/[^/]+\/branches$/.test(pathname)
	);
}
