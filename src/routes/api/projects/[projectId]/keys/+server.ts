import { json } from '@sveltejs/kit';
import { assertProjectId } from '$lib/server/agents';
import { listServiceKeys, mintServiceKey } from '$lib/server/service-keys';
import type { RequestHandler } from './$types';

/**
 * Project service keys.
 *
 * Operator-only by guard default, and deliberately NOT on the service-key
 * surface itself (`isServiceKeySurface`): a key must never be able to mint or
 * revoke keys, or it could outlive its own revocation.
 */

export const GET: RequestHandler = async ({ params, platform }) => {
	const projectId = assertProjectId(params.projectId);
	return json({ keys: await listServiceKeys(platform, projectId) });
};

export const POST: RequestHandler = async ({ params, request, platform, locals }) => {
	const projectId = assertProjectId(params.projectId);
	const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
	const result = await mintServiceKey(
		platform,
		projectId,
		body?.name,
		locals.consoleUser?.id ?? null
	);
	if (!result.ok) return json({ error: result.error }, { status: result.status });
	// The secret is in this response and nowhere else, ever again.
	return json(result, { status: 201 });
};
