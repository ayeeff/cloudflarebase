import { buildContentLoad, buildContentActions } from '$lib/server/admin-content';

export const load = buildContentLoad('blog', '/api/admin/blog');
export const actions = buildContentActions('/api/admin/blog');
