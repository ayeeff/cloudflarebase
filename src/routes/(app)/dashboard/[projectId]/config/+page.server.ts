import { assertProjectId } from '$lib/server/agents';
import type { PageServerLoad } from './$types';

/**
 * Remote Config renders from the client, not from SSR.
 *
 * Every other agent page loads its data server-side, but this one is an editor
 * whose whole interaction is "change things, then publish" - the list is
 * refetched after every mutation anyway, so an SSR copy would be stale by the
 * first keystroke and would only add a second code path to keep in step.
 * Provisioning is lazy on the agent side, so a project that never opens this
 * page never pays for the parameter table either.
 */
export const load: PageServerLoad = ({ params }) => {
	return { projectId: assertProjectId(params.projectId) };
};
