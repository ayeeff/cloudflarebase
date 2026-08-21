import { buildContentLoad, buildContentActions } from '$lib/server/admin-content';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = (event) => buildContentLoad(event, 'article');
export const actions: Actions = buildContentActions('articles');
