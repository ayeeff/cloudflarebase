import { AGENT_REGISTRY } from '$lib/agent-registry';
import { isDemoProjectId } from '$lib/console';
import { getDb } from '$lib/server/db';
import { app } from '$lib/server/db/schema';
import { assertProjectId, requireAgent } from '$lib/server/agents';
import { disconnectRepository } from '$lib/server/github-connect';
import { releaseAppClaim } from '$lib/server/hosting';
import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';

/**
 * Deletes an app: its deployed script and history in the agent, its GitHub
 * connection (so the next push cannot quietly resurrect it), and finally its
 * subdomain claim. Strictly in that order - the claim is released LAST,
 * because a freed name whose script still serves would hand the subdomain to
 * the next claimant while the old tenant's code answers on it.
 *
 * Operator sessions only (guard default; deploy tokens are deliberately not
 * admitted here - a CI credential that can deploy must not be able to erase).
 */
export const DELETE: RequestHandler = async ({ params, platform }) => {
	const projectId = assertProjectId(params.projectId);
	if (isDemoProjectId(projectId)) {
		return Response.json({ error: 'demo projects cannot deploy apps' }, { status: 403 });
	}
	const appName = params.appName;

	// 404 before any side effect: deleting an app this project never claimed
	// must not touch connections or the agent.
	const db = await getDb(platform);
	const [claim] = await db
		.select()
		.from(app)
		.where(and(eq(app.projectId, projectId), eq(app.appName, appName)))
		.limit(1);
	if (!claim) {
		return Response.json({ error: 'no such app' }, { status: 404 });
	}

	// Drop the connection first: a surviving one would re-register the app on
	// the very next push. Best effort on the workflow file, like disconnect.
	const disconnected = await disconnectRepository(platform, projectId, appName);

	const entry = AGENT_REGISTRY.hosting;
	const agent = requireAgent(platform, entry);
	const erase = await agent.fetch(
		`https://${entry.manifest.worker}/internal/projects/${encodeURIComponent(projectId)}/apps/${encodeURIComponent(appName)}`,
		{ method: 'DELETE' }
	);
	if (!erase.ok) {
		const body = (await erase.json().catch(() => null)) as { error?: string } | null;
		return Response.json(
			{ error: body?.error ?? 'the hosting agent could not erase the app' },
			{ status: 502 }
		);
	}

	await releaseAppClaim(platform, projectId, appName);
	return Response.json({
		deleted: true,
		subdomain: claim.subdomain,
		workflowRemoved: disconnected.workflowRemoved
	});
};
