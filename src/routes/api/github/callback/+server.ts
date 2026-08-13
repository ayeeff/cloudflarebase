import {
	appJwt,
	githubAppConfig,
	githubFetch,
	INSTALL_STATE_COOKIE,
	verifyInstallState
} from '$lib/server/github';
import { getConsoleSession } from '$lib/server/console';
import { recordInstallation } from '$lib/server/github-connect';
import { getProjectOwnership } from '$lib/server/registry';
import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * Where GitHub returns after an App install (docs/managed-service-design.md,
 * Phase B).
 *
 * This is the ONE moment an `installation_id` is trustworthy, and recording
 * the binding here is what every later connect checks instead of trusting the
 * id again. What makes it trustworthy is the SIGNED STATE, not a session:
 * this arrives as a cross-site top-level navigation from github.com, and a
 * session cookie is not reliably present on one - requiring it stranded
 * operators mid-install with a bare 401. The state is minted only for a
 * signed-in operator on a specific project, expires in minutes, and cannot
 * be forged without the webhook secret.
 *
 * The residual risk is narrow and deliberate: someone holding a live state
 * string could bind THEIR installation to that operator's project. They gain
 * nothing by it - `installationCoversProject` still gates every use on org
 * membership, so the installation becomes usable by the victim, not the
 * attacker - and the window is minutes. The session is still cross-checked
 * whenever the browser sends one.
 *
 * It always lands the operator somewhere useful; a failure is a message on
 * the Hosting page, never a bare error.
 */
export const GET: RequestHandler = async ({ url, platform, request, cookies }) => {
	const config = githubAppConfig(platform);
	if (!config) redirect(303, '/dashboard');

	// Query first, cookie second. GitHub does echo `state` on the install
	// redirect, but the cookie keeps the return leg working if that ever
	// changes or the App is configured differently.
	const state = await verifyInstallState(
		config,
		url.searchParams.get('state') ?? cookies.get(INSTALL_STATE_COOKIE) ?? null
	);
	cookies.delete(INSTALL_STATE_COOKIE, { path: '/' });
	const installationId = Number(url.searchParams.get('installation_id'));
	if (!state || !Number.isSafeInteger(installationId) || installationId <= 0) {
		redirect(303, '/dashboard?github=invalid');
	}

	// This is an open route, so the guard never resolved a session (the /login
	// precedent). Resolve it ourselves: absent is expected and fine, but a
	// session belonging to someone ELSE means the state was replayed in a
	// different browser and must not be honoured.
	const operator = await getConsoleSession(
		platform,
		url.origin,
		request.headers.get('cookie'),
		null
	);
	if (operator && operator.id !== state.userId) {
		redirect(303, '/dashboard?github=invalid');
	}

	const hosting = `/dashboard/${state.projectId}/hosting`;

	// GitHub is the authority on which account was installed on - the operator
	// picks it inside GitHub's own UI and never tells us.
	const response = await githubFetch(
		await appJwt(config),
		'GET',
		`/app/installations/${installationId}`
	);
	const account = (response.body as { account?: { login?: string } } | null)?.account?.login;
	if (!response.ok || !account) {
		redirect(303, `${hosting}?github=unreachable`);
	}

	const ownership = await getProjectOwnership(platform, state.projectId);
	await recordInstallation(platform, {
		installationId,
		orgId: ownership.orgId,
		accountLogin: account,
		userId: state.userId
	});

	redirect(303, `${hosting}?installation=${installationId}`);
};
