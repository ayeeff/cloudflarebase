import { activeOrg } from '$lib/console';
import type { LayoutServerLoad } from './$types';

/**
 * The account shell's sidebar data: the operator's organizations and the
 * active one. The guard resolves the identity for every operator page (and
 * for the bare /dashboard entry when a cookie is present), so this is a
 * per-request memo read, never a round trip. Anonymous demo visitors never
 * see this shell - the overview load hands them their demo project before
 * anything renders.
 */
export const load: LayoutServerLoad = ({ locals }) => {
	const identity = locals.consoleIdentity;
	const active = identity ? activeOrg(identity) : null;
	return {
		organizations: identity?.organizations ?? [],
		activeOrgId: active?.id ?? null,
		accountUser: identity ? { name: identity.user.name, email: identity.user.email } : null
	};
};
