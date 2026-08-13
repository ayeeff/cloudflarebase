import {
	appJwt,
	githubAppConfig,
	githubFetch,
	INSTALL_STATE_COOKIE,
	verifyInstallState
} from '$lib/server/github';
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
 * id again. Three things must agree: our signed state, the operator holding
 * the session (the guard resolved it - this route is operator-only like the
 * rest of `/api`), and GitHub's own view of the installation.
 *
 * It always lands the operator somewhere useful; a failure is a message on
 * the Hosting page, never a bare error.
 */
export const GET: RequestHandler = async ({ url, platform, locals, cookies }) => {
	const config = githubAppConfig(platform);
	if (!config) redirect(303, '/dashboard');

	// Query first, cookie second: GitHub's install redirect does not reliably
	// echo `state`, and without the fallback the operator lands back here with
	// nothing to prove which project they started from.
	const state = await verifyInstallState(
		config,
		url.searchParams.get('state') ?? cookies.get(INSTALL_STATE_COOKIE) ?? null
	);
	cookies.delete(INSTALL_STATE_COOKIE, { path: '/' });
	const installationId = Number(url.searchParams.get('installation_id'));
	if (
		!state ||
		!locals.consoleUser ||
		state.userId !== locals.consoleUser.id ||
		!Number.isSafeInteger(installationId) ||
		installationId <= 0
	) {
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
		userId: locals.consoleUser.id
	});

	redirect(303, `${hosting}?installation=${installationId}`);
};
