import { activeOrg } from '$lib/console';
import { recordDemoProject } from '$lib/server/demo-log';
import { listProjects } from '$lib/server/registry';
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

const COOKIE = 'cfb-demo-project';
// Roots only - the cookie remembers what this flow minted, never a branch.
// 12 hex now (17-char root), so `--production` still fits the 48-char
// project-id ceiling; 20-hex ids from before demo branches stay resumable.
const PROJECT_PATTERN = /^demo-[a-f0-9]{12,20}$/;

/**
 * The console entry point, which behaves differently for the two audiences
 * this deployment serves.
 *
 * On the public demo an anonymous visitor is handed their own throwaway
 * project, remembered in a cookie so a reload returns to the same one. For a
 * signed-in operator - the only case on a self-hosted install - it always
 * renders the overview: this page IS project and organization management
 * (org switcher, invitations, the Organization settings link, new-project),
 * so it never auto-forwards into a project. It used to skip the list when
 * exactly one project existed, which - once every account owned a personal
 * org - made "All projects" bounce straight back and left the org surfaces
 * unreachable.
 */
export const load: PageServerLoad = async ({ cookies, locals, platform }) => {
	if (locals.demoMode && !locals.consoleUser) {
		let projectId = cookies.get(COOKIE);
		if (!projectId || !PROJECT_PATTERN.test(projectId)) {
			projectId = `demo-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
			// The all-time demo counter on /admin; recordDemoProject never rejects.
			platform?.ctx.waitUntil(recordDemoProject(platform, projectId));
			cookies.set(COOKIE, projectId, {
				path: '/',
				httpOnly: true,
				sameSite: 'lax',
				secure: true,
				maxAge: 60 * 60 * 24 * 30
			});
		}
		redirect(307, `/dashboard/${projectId}`);
	}

	// The overview lists the ACTIVE org's projects (plus unowned rows every
	// operator may see); accounts with no orgs - agents from before
	// organizations - keep the unscoped list they always had.
	const identity = locals.consoleIdentity;
	const active = identity ? activeOrg(identity) : null;
	const projects = await listProjects(platform, active ? [active.id] : undefined);

	return {
		projects,
		organizations: identity?.organizations ?? [],
		activeOrgId: active?.id ?? null,
		pendingInvitations: identity?.pendingInvitations ?? []
	};
};
