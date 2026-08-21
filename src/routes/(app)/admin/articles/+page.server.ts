import { buildContentLoad, buildContentActions } from '$lib/server/admin-content';

export const load = buildContentLoad('article', '/api/admin/articles');
export const actions = buildContentActions('/api/admin/articles');
