import type { RequestHandler } from './$types';

/**
 * The operator's identity: session, org memberships, pending invitations.
 * Operator-only by the guard's fail-closed default, and already resolved by
 * it - this endpoint just surfaces the per-request memo, so the org switcher
 * and the CLI pay zero extra agent round trips.
 */
export const GET: RequestHandler = async ({ locals }) => {
	return Response.json(locals.consoleIdentity);
};
