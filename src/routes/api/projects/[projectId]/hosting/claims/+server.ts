import { AGENT_REGISTRY } from '$lib/agent-registry';
import { assertProjectId, requireAgent } from '$lib/server/agents';
import { listAppClaims, resolveAppClaim } from '$lib/server/hosting';
import { z } from 'zod';
import type { RequestHandler } from './$types';

/**
 * Subdomain claims, console-plane (the control plane owns the global
 * namespace). GET lists this project's claims; POST resolves one - with
 * `dry: true` it only reports what WOULD be claimed, which is how
 * bare `cloudflarebase init` shows the auto-numbered suggestion before
 * claiming.
 */

const claimBodySchema = z.object({
	app: z.unknown(),
	dry: z.boolean().optional()
});

export const GET: RequestHandler = async ({ params, platform }) => {
	const projectId = assertProjectId(params.projectId);
	return Response.json({ claims: await listAppClaims(platform, projectId) });
};

export const POST: RequestHandler = async ({ params, request, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const body = claimBodySchema.safeParse(await request.json().catch(() => null));
	if (!body.success) {
		return Response.json({ error: 'expected { app, dry? }' }, { status: 400 });
	}

	const claim = await resolveAppClaim(platform, projectId, body.data.app, {
		dry: body.data.dry
	});
	if (!claim.ok) {
		return Response.json({ error: claim.error }, { status: claim.status });
	}

	// A real claim is pushed to the agent right away so the app shows up on
	// the Hosting page before its first deploy. Best-effort: the deploy route
	// re-pushes, so an unreachable agent here costs nothing but the preview.
	if (!body.data.dry) {
		const entry = AGENT_REGISTRY.hosting;
		try {
			const agent = requireAgent(platform, entry);
			await agent.fetch(
				`https://${entry.manifest.worker}/internal/projects/${encodeURIComponent(projectId)}/apps/${encodeURIComponent(claim.appName)}`,
				{
					method: 'PUT',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ subdomain: claim.subdomain })
				}
			);
		} catch {
			// the claim row is persisted; the first deploy completes the link
		}
	}

	return Response.json(
		{ subdomain: claim.subdomain, appName: claim.appName, created: claim.created },
		{ status: claim.created ? 201 : 200 }
	);
};
