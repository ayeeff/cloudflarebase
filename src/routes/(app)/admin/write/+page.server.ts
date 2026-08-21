import { buildContentLoad, buildContentActions } from '$lib/server/admin-content';

export const load = buildContentLoad('write', '/api/admin/write');
export const actions = buildContentActions('/api/admin/write');
