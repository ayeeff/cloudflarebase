import { assertProjectId } from '$lib/server/agents';
import { isDemoProjectId } from '$lib/console';
import {
	githubAppConfig,
	INSTALL_STATE_COOKIE,
	installUrl,
	signInstallState
} from '$lib/server/github';
import type { RequestHandler } from './$types';

/**
 * Where the operator goes to install the App and pick repositories.
 *
 * The `state` is signed and carries the operator and the project, which is
 * what lets the callback trust the `installation_id` GitHub hands back on a
 * redirect anyone could otherwise craft.
 *
 * It rides BOTH the URL and a short-lived cookie. GitHub's install redirect
 * is a different flow from user authorization, and whether it echoes `state`
 * back depends on how the App is configured - so the cookie is what makes
 * the return leg work regardless, without weakening anything: it is the same
 * signed token, verified the same way.
 */
export const GET: RequestHandler = async ({ params, platform, locals, cookies, url }) => {
	const projectId = assertProjectId(params.projectId);
	if (isDemoProjectId(projectId)) {
		return Response.json({ error: 'demo projects cannot deploy apps' }, { status: 403 });
	}
	const config = githubAppConfig(platform);
	if (!config) {
		return Response.json({ error: 'no GitHub App is configured on this console' }, { status: 503 });
	}
	if (!locals.consoleUser) {
		// The guard already required a session; this keeps the type honest.
		return Response.json({ error: 'sign in first' }, { status: 401 });
	}

	const state = await signInstallState(config, { projectId, userId: locals.consoleUser.id });
	cookies.set(INSTALL_STATE_COOKIE, state, {
		path: '/',
		httpOnly: true,
		// The return leg is a top-level navigation from github.com, so Lax is
		// what lets the cookie ride along; Strict would drop it.
		sameSite: 'lax',
		// http in local dev would otherwise refuse to store it.
		secure: url.protocol === 'https:',
		maxAge: 15 * 60
	});
	return Response.json({ url: installUrl(config, state) });
};
