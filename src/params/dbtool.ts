import type { ParamMatcher } from '@sveltejs/kit';

/**
 * The db workspace's tool pages (Neon-style page-per-tool): /db is the
 * collections browser, and these are its sibling routes. Anything else under
 * /db/<x> is a 404, never a silently-empty workspace.
 */
export const match: ParamMatcher = (param) =>
	['tables', 'sql', 'access', 'replication', 'integration'].includes(param);
