/** Shared constants + helpers for the e2e suite. */

/** Project seeded once per stack by seed.setup.ts - treat as read-only in tests. */
export const SEED_PROJECT = 'e2e-seed';

/**
 * Scratch project for tests that must create users. The seed project's counts
 * are asserted exactly, so writing into it breaks unrelated specs.
 */
export const SCRATCH_PROJECT = 'e2e-scratch';

/**
 * Reserved project id backing the console's own operator auth. Every console
 * surface requires a session on it, so the suite claims an owner before
 * anything else runs (console.setup.ts) and reuses that storage state.
 */
export const CONSOLE_PROJECT = 'console';

export const CONSOLE_OWNER = {
	name: 'E2E Operator',
	email: 'operator@example.com',
	password: 'e2e-console-owner-1'
} as const;

/** Where console.setup.ts parks the operator session for the other projects. */
export const CONSOLE_STORAGE_STATE = 'e2e/.auth/console.json';

export function consoleAuthPath(endpoint: string): string {
	return authPath(CONSOLE_PROJECT, endpoint);
}

export const SEED_PASSWORD = 'seeded-user-password-1';

export const SEED_USERS = [
	{ name: 'Grace Hopper', email: 'grace@example.com', password: SEED_PASSWORD },
	{ name: 'Alan Turing', email: 'alan@example.com', password: SEED_PASSWORD }
] as const;

/** Registered seed users + exactly one anonymous guest. */
export const SEED_TOTAL_USERS = SEED_USERS.length + 1;

let counter = 0;

/** Unique-per-run email so re-runs and retries never collide. */
export function uniqueEmail(prefix: string): string {
	counter += 1;
	return `${prefix}-${Date.now()}-${counter}@example.com`;
}

export function authPath(projectId: string, endpoint: string): string {
	return `/api/projects/${projectId}/auth/${endpoint}`;
}

export function overviewPath(projectId: string): string {
	return `/api/projects/${projectId}/overview`;
}

export function analyticsPath(projectId: string): string {
	return `/api/projects/${projectId}/analytics`;
}

export function chatPath(projectId: string): string {
	return `/api/projects/${projectId}/chat`;
}

export function adminUserPath(projectId: string, userId: string): string {
	return `/api/projects/${projectId}/admin/users/${encodeURIComponent(userId)}`;
}

export function adminSessionPath(projectId: string, sessionId: string): string {
	return `/api/projects/${projectId}/admin/sessions/${encodeURIComponent(sessionId)}`;
}

export function settingsPath(projectId: string): string {
	return `/api/projects/${projectId}/admin/settings`;
}

export function configPath(projectId: string): string {
	return `/api/projects/${projectId}/config`;
}

export function authPage(projectId: string): string {
	return `/dashboard/${projectId}/auth`;
}

/**
 * Project the db agent specs self-seed. Collections are idempotent upserts or
 * carry a per-run suffix so reused local stacks never collide, and nothing
 * else asserts on this project's contents.
 */
export const DB_PROJECT = 'e2e-db';

export function dbAdminCollectionPath(projectId: string, name: string): string {
	return `/api/projects/${projectId}/db/admin/collections/${encodeURIComponent(name)}`;
}

export function dbDocumentsPath(projectId: string, collection: string): string {
	return `/api/projects/${projectId}/db/collections/${collection}/documents`;
}

export function dbDocumentPath(projectId: string, collection: string, docId: string): string {
	return `/api/projects/${projectId}/db/collections/${collection}/documents/${encodeURIComponent(docId)}`;
}

export function dbQueryPath(projectId: string, collection: string): string {
	return `/api/projects/${projectId}/db/collections/${collection}/query`;
}

export function dbAggregatePath(projectId: string, collection: string): string {
	return `/api/projects/${projectId}/db/collections/${collection}/aggregate`;
}

export function dbExportPath(projectId: string, collection: string): string {
	return `/api/projects/${projectId}/db/collections/${collection}/export`;
}

export function dbAdminQueryPath(projectId: string): string {
	return `/api/projects/${projectId}/db/admin/query`;
}

export function dbAdminAggregatePath(projectId: string): string {
	return `/api/projects/${projectId}/db/admin/aggregate`;
}

export function dbAdminExportPath(projectId: string, name: string): string {
	return `${dbAdminCollectionPath(projectId, name)}/export`;
}

export function dbAdminImportPath(projectId: string, name: string): string {
	return `${dbAdminCollectionPath(projectId, name)}/import`;
}

export function dbAdminRestorePath(projectId: string, name: string): string {
	return `${dbAdminCollectionPath(projectId, name)}/restore`;
}

export function dbOverviewPath(projectId: string): string {
	return `/api/projects/${projectId}/db/overview`;
}

// --- SQL tables (schema-first; declared via the admin surface) ---

export function dbAdminTablePath(projectId: string, name: string): string {
	return `/api/projects/${projectId}/db/admin/tables/${encodeURIComponent(name)}`;
}

export function dbAdminTableRowPath(projectId: string, name: string, rowId: string): string {
	return `${dbAdminTablePath(projectId, name)}/rows/${encodeURIComponent(rowId)}`;
}

export function dbRowsPath(projectId: string, table: string): string {
	return `/api/projects/${projectId}/db/tables/${table}/rows`;
}

export function dbRowPath(projectId: string, table: string, rowId: string): string {
	return `/api/projects/${projectId}/db/tables/${table}/rows/${encodeURIComponent(rowId)}`;
}

export function dbTableQueryPath(projectId: string, table: string): string {
	return `/api/projects/${projectId}/db/tables/${table}/query`;
}
