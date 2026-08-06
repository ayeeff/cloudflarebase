import type { ParamMatcher } from '@sveltejs/kit';

/**
 * The auth workspace's tool pages (Neon-style page-per-tool): /auth is Users,
 * and these are its sibling routes. Anything else under /auth/<x> is a 404.
 */
export const match: ParamMatcher = (param) =>
	['sessions', 'roles', 'settings', 'playground', 'integration'].includes(param);
