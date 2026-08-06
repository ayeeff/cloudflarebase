import * as Sentry from '@sentry/sveltekit';
import { demoRootId, isDemoProjectId, RESERVED_PROJECT_IDS } from '$lib/console';
import { AGENT_REGISTRY } from '$lib/agent-registry';
import type { RegistryProject } from '$lib/agents';
import { getDb } from '$lib/server/db';
import { project, projectAgent } from '$lib/server/db/schema';
import { requireAgent } from '$lib/server/agents';
import { projectIdSchema } from '$lib/schemas/auth';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';

/**
 * The project registry: which projects this installation owns.
 *
 * It lives in D1 on the dashboard Worker rather than inside an agent, because
 * it is a control-plane concern. A project will eventually have a db agent and
 * a storage agent as well as auth, so any agent owning the list would make
 * every other agent depend on that one - and deleting a project has to reach
 * all of them, which is why the fan-out below belongs here and not in the auth
 * worker.
 */

export const createProjectSchema = z.object({
	id: projectIdSchema
		.refine((value) => !RESERVED_PROJECT_IDS.has(value), 'that project id is reserved')
		// `--` is the branch separator (docs/branches-design.md): keeping it out
		// of NEW user-chosen ids is what makes `<root>--<branch>` unambiguous.
		// Rows that predate this rule stay valid - the registry's parent_id
		// column decides what is a branch, never the string shape.
		.refine((value) => !value.includes('--'), 'project ids may not contain "--"'),
	name: z.string().trim().min(1, 'name is required').max(64)
});

/** Branch names: short, id-charset, no `--` (it is the separator), and the
 * combined `<root>--<branch>` must still satisfy projectIdSchema's 32-char
 * ceiling - checked at create where the root id is known. */
export const branchNameSchema = z
	.string()
	.regex(/^[a-z0-9][a-z0-9-]{0,15}$/, 'Use lowercase letters, numbers, and hyphens only.')
	.refine((value) => !value.includes('--'), 'branch names may not contain "--"');

export const createBranchSchema = z.object({ branch: branchNameSchema });

/** Ceiling on one installation, to keep an accidental loop from filling D1. */
const MAX_PROJECTS = 100;

function toDto(row: {
	id: string;
	name: string;
	parentId: string | null;
	branchName: string | null;
	createdAt: Date;
}): RegistryProject {
	return {
		id: row.id,
		name: row.name,
		parentId: row.parentId,
		branchName: row.branchName,
		createdAt: row.createdAt.toISOString()
	};
}

/**
 * Lists the installation's projects, oldest first. Returns an empty list
 * rather than throwing when the database cannot be reached, so a first-run
 * console renders its empty state instead of an error page.
 */
export async function listProjects(platform: App.Platform | undefined): Promise<RegistryProject[]> {
	try {
		const db = await getDb(platform);
		const rows = await db.select().from(project).orderBy(asc(project.createdAt));
		return rows.map(toDto);
	} catch (cause) {
		// Degrading to "no projects" is right for a first run but wrong to do
		// silently: on a real installation it means the control plane is
		// unreachable, and the console looks empty rather than broken.
		console.error('listing projects failed', cause);
		Sentry.captureException(cause, {
			level: 'error',
			tags: { operation: 'list-projects' }
		});
		return [];
	}
}

export type CreateProjectResult =
	{ ok: true; project: RegistryProject } | { ok: false; status: number; error: string };

export async function createProject(
	platform: App.Platform | undefined,
	input: unknown
): Promise<CreateProjectResult> {
	const parsed = createProjectSchema.safeParse(input);
	if (!parsed.success) {
		return { ok: false, status: 400, error: parsed.error.issues[0]?.message ?? 'invalid project' };
	}

	const db = await getDb(platform);

	const [existing] = await db.select().from(project).where(eq(project.id, parsed.data.id)).limit(1);
	if (existing) {
		return { ok: false, status: 409, error: 'that project id is already taken' };
	}

	const rows = await db.select({ id: project.id }).from(project);
	if (rows.length >= MAX_PROJECTS) {
		return {
			ok: false,
			status: 409,
			error: `this installation is limited to ${MAX_PROJECTS} projects`
		};
	}

	const [created] = await db
		.insert(project)
		.values({ id: parsed.data.id, name: parsed.data.name, createdAt: new Date() })
		.returning();

	await enableRegistryAgents(db, created.id);

	return { ok: true, project: toDto(created) };
}

/** Every registry agent is enabled by default. Deletion never reads these
 * rows (erase always fans out to every agent), so this is bookkeeping the
 * console can build on, not a gate user data depends on. */
async function enableRegistryAgents(
	db: Awaited<ReturnType<typeof getDb>>,
	projectId: string
): Promise<void> {
	await db
		.insert(projectAgent)
		.values(
			Object.values(AGENT_REGISTRY).map(({ manifest }) => ({
				projectId,
				agent: manifest.name,
				enabledAt: new Date()
			}))
		)
		.onConflictDoNothing();
}

export type CreateBranchResult =
	{ ok: true; project: RegistryProject } | { ok: false; status: number; error: string };

/**
 * Mints a branch of a root project: a full registry row whose id is
 * `<rootId>--<branch>` (docs/branches-design.md). The derived id IS the
 * isolation - every agent keys on project id, so the branch gets its own
 * Durable Objects, JWKS keypair, replicas, and analytics with zero agent
 * involvement. v1 branches start empty, like a fresh project.
 */
export async function createBranch(
	platform: App.Platform | undefined,
	rootId: string,
	input: unknown
): Promise<CreateBranchResult> {
	if (!projectIdSchema.safeParse(rootId).success) {
		return { ok: false, status: 400, error: 'invalid project id' };
	}
	if (isDemoProjectId(rootId)) {
		// A demo project IS an ephemeral branch already; it never gets its own.
		return { ok: false, status: 400, error: 'demo projects cannot have branches' };
	}
	const parsed = createBranchSchema.safeParse(input);
	if (!parsed.success) {
		return { ok: false, status: 400, error: parsed.error.issues[0]?.message ?? 'invalid branch' };
	}
	if (parsed.data.branch === 'main') {
		return { ok: false, status: 400, error: '"main" is the root project itself' };
	}

	const db = await getDb(platform);
	const [root] = await db.select().from(project).where(eq(project.id, rootId)).limit(1);
	if (!root) return { ok: false, status: 404, error: 'no such project' };
	if (root.parentId) {
		return { ok: false, status: 400, error: 'branches cannot have branches - branch the root' };
	}

	const branchId = `${rootId}--${parsed.data.branch}`;
	if (!projectIdSchema.safeParse(branchId).success) {
		return {
			ok: false,
			status: 400,
			error: 'the combined id exceeds 32 characters - use a shorter branch name'
		};
	}
	const [existing] = await db.select().from(project).where(eq(project.id, branchId)).limit(1);
	if (existing) {
		return { ok: false, status: 409, error: 'that branch already exists' };
	}
	const rows = await db.select({ id: project.id }).from(project);
	if (rows.length >= MAX_PROJECTS) {
		return {
			ok: false,
			status: 409,
			error: `this installation is limited to ${MAX_PROJECTS} projects`
		};
	}

	const [created] = await db
		.insert(project)
		.values({
			id: branchId,
			name: `${root.name} (${parsed.data.branch})`,
			parentId: rootId,
			branchName: parsed.data.branch,
			createdAt: new Date()
		})
		.returning();

	await enableRegistryAgents(db, created.id);

	return { ok: true, project: toDto(created) };
}

export interface BranchContext {
	/** The root project id (the current project itself when it is not a branch). */
	rootId: string;
	/** Branch name of the CURRENT project; null when it is the root (`main`). */
	current: string | null;
	/** The root's branches, oldest first. */
	branches: RegistryProject[];
	/** Synthesized demo context: branches are id-derived, never registry rows,
	 * and creation is client-side navigation instead of POST /branches. */
	demo?: boolean;
}

/**
 * Branch context for a DEMO project family - synthesized, never stored.
 * Every demo gets production and preview branches (plus whatever the visitor
 * navigated to), derived purely from the id: the broadened demo pattern gives
 * each branch instance the same caps and TTL erasure as its root, so nothing
 * needs registering for ids that erase themselves. Null for pre-branch 20-hex
 * demo roots, whose ids leave no room under the 32-char ceiling.
 */
export function demoBranchContext(projectId: string): BranchContext | null {
	if (!isDemoProjectId(projectId)) return null;
	const rootId = demoRootId(projectId);
	const current = projectId === rootId ? null : projectId.slice(rootId.length + 2);
	const names = ['production', 'preview'];
	if (current && !names.includes(current)) names.push(current);
	const branches = names
		.map((branchName) => ({
			id: `${rootId}--${branchName}`,
			name: `Demo (${branchName})`,
			parentId: rootId,
			branchName,
			createdAt: new Date(0).toISOString()
		}))
		.filter((branch) => projectIdSchema.safeParse(branch.id).success);
	if (branches.length === 0) return null;
	return { demo: true, rootId, current, branches };
}

/**
 * The header branch switcher's data: the current project's root and that
 * root's branches. Null for demo ids, unregistered projects, and an
 * unreachable control plane - the dashboard hides the control instead of
 * failing the layout, and a capture keeps the degraded case visible.
 */
export async function getBranchContext(
	platform: App.Platform | undefined,
	projectId: string
): Promise<BranchContext | null> {
	if (!projectIdSchema.safeParse(projectId).success || isDemoProjectId(projectId)) return null;
	try {
		const db = await getDb(platform);
		const [row] = await db.select().from(project).where(eq(project.id, projectId)).limit(1);
		if (!row) return null;
		const rootId = row.parentId ?? row.id;
		const rows = await db
			.select()
			.from(project)
			.where(eq(project.parentId, rootId))
			.orderBy(asc(project.createdAt));
		return { rootId, current: row.branchName, branches: rows.map(toDto) };
	} catch (cause) {
		console.error('loading branch context failed', cause);
		Sentry.captureException(cause, {
			level: 'error',
			tags: { operation: 'branch-context', projectId }
		});
		return null;
	}
}

/** A root project's branches, oldest first (the switcher's data). */
export async function listBranches(
	platform: App.Platform | undefined,
	rootId: string
): Promise<RegistryProject[]> {
	const db = await getDb(platform);
	const rows = await db
		.select()
		.from(project)
		.where(eq(project.parentId, rootId))
		.orderBy(asc(project.createdAt));
	return rows.map(toDto);
}

export type DeleteProjectResult =
	{ ok: true; warning?: string } | { ok: false; status: number; error: string };

/**
 * Removes a project's registration and erases its data in every agent.
 *
 * Both halves matter: dropping only the row would strand Durable Objects still
 * holding real user records with nothing left that could reach or delete them.
 * The fan-out lives here because the console is the only component that knows
 * which agents exist - today that is the auth agent, and each new agent adds a
 * call rather than a dependency between agents.
 */
export async function deleteProject(
	platform: App.Platform | undefined,
	projectId: string
): Promise<DeleteProjectResult> {
	if (!projectIdSchema.safeParse(projectId).success) {
		return { ok: false, status: 400, error: 'invalid project id' };
	}

	const db = await getDb(platform);

	// Deleting a ROOT deletes its branches first - the db registry's
	// child-first invariant one level up: no branch row may outlive the root
	// it hangs off, and each branch is a full project erase of its own.
	const branches = await db
		.select({ id: project.id })
		.from(project)
		.where(eq(project.parentId, projectId));
	const failures: string[] = [];
	for (const branch of branches) {
		await db.delete(project).where(eq(project.id, branch.id));
		for (const failure of await eraseProjectData(platform, branch.id)) {
			failures.push(`${failure} (${branch.id})`);
		}
	}

	const deleted = await db.delete(project).where(eq(project.id, projectId)).returning();
	if (!deleted.length) {
		return { ok: false, status: 404, error: 'no such project' };
	}

	failures.push(...(await eraseProjectData(platform, projectId)));
	if (failures.length) {
		return { ok: true, warning: `data could not be erased in: ${failures.join(', ')}` };
	}
	return { ok: true };
}

/** Fan-out erase. Returns the names of agents that could not be reached. */
async function eraseProjectData(
	platform: App.Platform | undefined,
	projectId: string
): Promise<string[]> {
	const failures: string[] = [];

	for (const entry of Object.values(AGENT_REGISTRY)) {
		const { manifest } = entry;
		try {
			const agent = requireAgent(platform, entry);
			// Synthetic host: the erase route sits outside /agents/* on purpose,
			// reachable only over the service binding.
			const path = manifest.erase.path.replace(':projectId', encodeURIComponent(projectId));
			const response = await agent.fetch(`https://${manifest.worker}${path}`, {
				method: manifest.erase.method
			});
			if (!response.ok) throw new Error(`${manifest.name} agent responded ${response.status}`);
		} catch (cause) {
			// A failed erase leaves a project's data behind after the operator
			// deleted it - a retention problem, not a cosmetic one. The caller
			// only surfaces a warning string, so capture it or nobody finds out.
			console.error(`failed to erase project "${projectId}" in the ${manifest.name} agent`, cause);
			Sentry.captureException(cause, {
				level: 'error',
				tags: { projectId, agent: manifest.name, operation: 'erase-project' }
			});
			failures.push(manifest.name);
		}
	}

	return failures;
}
