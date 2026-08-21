import type { ParamMatcher } from '@sveltejs/kit';

/**
 * The per-app hosting page's tabs (the CF Workers dashboard shape): the bare
 * app route is Overview, and these are its sibling tabs. Anything else under
 * /hosting/apps/<app>/<x> is a 404, never a silently-empty page.
 */
export const match: ParamMatcher = (param) =>
	['deployments', 'analytics', 'settings'].includes(param);
