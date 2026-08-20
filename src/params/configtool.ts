import type { ParamMatcher } from '@sveltejs/kit';

/**
 * Remote Config's tool pages, mirroring the db workspace's page-per-tool
 * shape: /config is the parameter editor, /config/integration shows how an
 * app reads the values. Anything else under /config/<x> is a 404.
 */
export const match: ParamMatcher = (param) => ['integration'].includes(param);
