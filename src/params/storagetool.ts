import type { ParamMatcher } from '@sveltejs/kit';

/**
 * The storage workspace's tool pages (the db/auth convention): bare /storage
 * is the file browser, and these are its sibling routes. Anything else under
 * /storage/<x> is a 404, never a silently-empty workspace.
 */
export const match: ParamMatcher = (param) => ['access', 'integration'].includes(param);
