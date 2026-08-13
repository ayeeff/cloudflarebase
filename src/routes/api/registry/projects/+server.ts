import { activeOrg } from '$lib/console';
import { createProject, listProjects } from '$lib/server/registry';
import type { RequestHandler } from './$types';

/**
 * Project registry for this installation. Operator-only: the console guard in
 * hooks.server.ts rejects everything under /api that is not explicitly public,
 * so these handlers never run without a session - and locals.consoleIdentity
 * is already resolved.
 */

export const GET: RequestHandler = async ({ locals, platform }) => {
	// Scoped to the operator's memberships plus unowned rows; an identity with
	// no orgs (a pre-orgs agent, the 404 fallback) sees unowned rows only -
	// which on a legacy install is everything.
	const orgIds = locals.consoleIdentity?.organizations.map((org) => org.id);
	return Response.json({ projects: await listProjects(platform, orgIds) });
};

export const POST: RequestHandler = async ({ locals, platform, request }) => {
	// New projects belong to the creator's active org. Accounts without one
	// (agents from before organizations) keep minting unowned rows - exactly
	// the legacy visibility they already have.
	const org = locals.consoleIdentity ? activeOrg(locals.consoleIdentity) : null;
	const result = await createProject(
		platform,
		await request.json().catch(() => null),
		org?.id ?? null
	);

	if (!result.ok) {
		return Response.json({ error: result.error }, { status: result.status });
	}
	return Response.json({ project: result.project }, { status: 201 });
};
