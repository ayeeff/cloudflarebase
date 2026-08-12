import { activeOrg } from '$lib/console';
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * The active organization's settings: members, invitations, rename. Data
 * comes from the per-request identity memo; the member/invitation lists load
 * client-side through the console auth proxy (they are Better Auth endpoints
 * that authorize themselves against the session cookie).
 */
export const load: PageServerLoad = async ({ locals }) => {
	const identity = locals.consoleIdentity;
	// The guard already bounced anonymous visitors; no org means an account
	// from before organizations whose personal org has not healed yet - the
	// overview visit does that, so send them there.
	if (!identity) redirect(303, '/login?next=/dashboard/organization');
	const org = activeOrg(identity);
	if (!org) redirect(303, '/dashboard');

	return {
		org,
		organizations: identity.organizations,
		user: identity.user
	};
};
