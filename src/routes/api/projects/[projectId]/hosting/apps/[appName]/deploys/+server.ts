import { AGENT_REGISTRY } from '$lib/agent-registry';
import { isDemoProjectId } from '$lib/console';
import { agentUrl, assertProjectId, requireAgent, toNativeResponse } from '$lib/server/agents';
import { resolveAppClaim } from '$lib/server/hosting';
import type { RequestHandler } from './$types';

/**
 * The deploy endpoint (Phase B). The console
 * resolves the subdomain claim BEFORE proxying - claims are control-plane
 * state, the agent owns no global namespace - then pushes the result to the
 * agent's service-binding-only link route and forwards the multipart deploy.
 * The agent only ever deploys to subdomains recorded for this project, which
 * is what makes the operator surface safe.
 *
 * Reachable with an operator session (guard default) OR a deploy token (the
 * guard admits `cfbd_` bearers on exactly this POST for the token's family).
 */
export const POST: RequestHandler = async ({ params, request, url, platform }) => {
	const projectId = assertProjectId(params.projectId);
	if (isDemoProjectId(projectId)) {
		// No demo hosting: anonymous code execution is an abuse machine. The
		// dashboard shows an upsell card instead.
		return Response.json({ error: 'demo projects cannot deploy apps' }, { status: 403 });
	}

	// Reuse the persisted claim or mint one under the auto-numbering rule.
	const claim = await resolveAppClaim(platform, projectId, params.appName);
	if (!claim.ok) {
		return Response.json({ error: claim.error }, { status: claim.status });
	}

	const entry = AGENT_REGISTRY.hosting;
	const agent = requireAgent(platform, entry);

	// Synthetic host: the link route sits outside /agents/* on purpose,
	// reachable only over the service binding (the erase-route precedent).
	const push = await agent.fetch(
		`https://${entry.manifest.worker}/internal/projects/${encodeURIComponent(projectId)}/apps/${encodeURIComponent(claim.appName)}`,
		{
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ subdomain: claim.subdomain })
		}
	);
	if (!push.ok) {
		const body = (await push.json().catch(() => null)) as { error?: string } | null;
		return Response.json(
			{ error: body?.error ?? 'the hosting agent refused the app' },
			{ status: push.status }
		);
	}

	const target = agentUrl(
		url.origin,
		entry,
		projectId,
		`/apps/${encodeURIComponent(claim.appName)}/deploys`
	);
	// Pass url + init (not a Request object): in dev the service binding is a
	// miniflare proxy that can't consume Requests from the Node realm. Full
	// headers so the multipart boundary survives.
	const response = await agent.fetch(target, {
		method: 'POST',
		headers: [...request.headers],
		body: await request.arrayBuffer()
	});
	return toNativeResponse(response as unknown as Response);
};
