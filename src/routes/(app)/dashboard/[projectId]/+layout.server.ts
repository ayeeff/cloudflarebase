import { consoleAuthConfig, isDemoProjectId } from '$lib/server/console';
import {
	demoBranchContext,
	getBranchContext,
	listProjects,
	rememberDemoBranch
} from '$lib/server/registry';
import type { LayoutServerLoad } from './$types';

// The agent pane's open state and split sizes persist in a cookie (written by
// the dashboard layout on resize/toggle) so SSR renders the saved layout
// directly - restoring a resized pane never flashes the default widths.
// Format: "open:70:30" | "closed:70:30".
export const load: LayoutServerLoad = async ({ cookies, params, platform, locals, url }) => {
	const [state, ...rest] = (cookies.get('cfbase-copilot') ?? '').split(':');
	const sizes = rest.map(Number);
	const layout =
		sizes.length === 2 && sizes.every((size) => Number.isFinite(size) && size >= 15 && size <= 85)
			? sizes
			: null;
	const [branches, projects] = await Promise.all([
		// Null hides the branch controls (unregistered projects, unreachable
		// control plane). UNCLAIMED demo families get a SYNTHESIZED context
		// instead - production/preview plus every branch this visitor minted
		// (remembered in a cookie, since demo branches are ids and not registry
		// rows), so demo visitors experience branching without touching the
		// registry. A CLAIMED demo is a registered project: for signed-in
		// operators the registry is consulted first and only a missing row
		// falls back to the synthesized context. Re-runs only when the project
		// param changes, so subpage navigation costs no registry reads.
		locals.demoMode && isDemoProjectId(params.projectId)
			? (locals.consoleUser
					? getBranchContext(platform, params.projectId)
					: Promise.resolve(null)
				).then(
					(registered) =>
						registered ??
						demoBranchContext(params.projectId, rememberDemoBranch(cookies, params.projectId))
				)
			: getBranchContext(platform, params.projectId),
		// The breadcrumb project switcher's list - operators only, scoped to
		// their org memberships. Demo mode serves this layout to anonymous
		// visitors, and the installation's project registry must never appear
		// in their page data.
		locals.consoleUser
			? listProjects(
					platform,
					locals.consoleIdentity?.organizations.map((org) => org.id)
				)
			: Promise.resolve(null)
	]);

	// Whether the "Keep this project" claim CTA can lead anywhere. A signed-in
	// operator always can (they have an account to own it). An ANONYMOUS demo
	// visitor can only complete the flow when the console reports open
	// sign-ups - on a claimed console the /login hand-off is a dead end, so
	// the button must not exist. Resolved only for anonymous demo families,
	// and only when the project param changes.
	const demoClaimable = locals.consoleUser
		? true
		: locals.demoMode && isDemoProjectId(params.projectId)
			? (await consoleAuthConfig(platform, url.origin)).consoleSignups === 'open'
			: false;

	return {
		copilot: {
			open: state !== 'closed',
			layout
		},
		branches,
		projects,
		demoClaimable
	};
};
