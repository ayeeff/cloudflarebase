import { getBranchContext, listProjects } from '$lib/server/registry';
import type { LayoutServerLoad } from './$types';

// The agent pane's open state and split sizes persist in a cookie (written by
// the dashboard layout on resize/toggle) so SSR renders the saved layout
// directly - restoring a resized pane never flashes the default widths.
// Format: "open:70:30" | "closed:70:30".
export const load: LayoutServerLoad = async ({ cookies, params, platform, locals }) => {
	const [state, ...rest] = (cookies.get('cfbase-copilot') ?? '').split(':');
	const sizes = rest.map(Number);
	const layout =
		sizes.length === 2 && sizes.every((size) => Number.isFinite(size) && size >= 15 && size <= 85)
			? sizes
			: null;
	const [branches, projects] = await Promise.all([
		// Null hides the branch controls (demo ids, unregistered projects,
		// unreachable control plane). Re-runs only when the project param
		// changes, so subpage navigation costs no registry reads.
		getBranchContext(platform, params.projectId),
		// The breadcrumb project switcher's list - operators only. Demo mode
		// serves this layout to anonymous visitors, and the installation's
		// project registry must never appear in their page data.
		locals.consoleUser ? listProjects(platform) : Promise.resolve(null)
	]);
	return {
		copilot: {
			open: state !== 'closed',
			layout
		},
		branches,
		projects
	};
};
