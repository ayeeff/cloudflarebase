import { activeOrg } from '$lib/console';
import { assertProjectId } from '$lib/server/auth-agent';
import { getConsoleIdentity } from '$lib/server/console';
import { claimDemoProject } from '$lib/server/registry';
import type { RequestHandler } from './$types';

/**
 * Claims a demo project for the signed-in operator's active organization.
 *
 * The guard lets ANONYMOUS traffic reach unregistered demo ids (that is what
 * a demo is), so this handler resolves the session itself instead of trusting
 * locals - a claim without an account is meaningless. Once the row exists the
 * guard requires ownership on every later request, first-claim-wins by
 * primary-key atomicity.
 */
export const POST: RequestHandler = async ({ locals, params, platform, request, url }) => {
	const projectId = assertProjectId(params.projectId);

	const identity =
		locals.consoleIdentity ??
		(await getConsoleIdentity(
			platform,
			url.origin,
			request.headers.get('cookie'),
			request.headers.get('authorization')
		));
	if (!identity) {
		return Response.json({ error: 'sign in to keep this project' }, { status: 401 });
	}
	const org = activeOrg(identity);
	if (!org) {
		return Response.json(
			{ error: 'your account has no organization to own this project' },
			{ status: 400 }
		);
	}

	const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
	const name = typeof body?.name === 'string' ? body.name.slice(0, 64) : 'Claimed demo';

	const result = await claimDemoProject(platform, projectId, org.id, name);
	if (!result.ok) {
		return Response.json({ error: result.error }, { status: result.status });
	}
	// 207 mirrors the erase route: the registration is consistent, but an
	// agent could not be reached and kept its demo limits armed.
	return result.warning
		? Response.json({ project: result.project, warning: result.warning }, { status: 207 })
		: Response.json({ project: result.project }, { status: 201 });
};
