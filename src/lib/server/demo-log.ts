import { getDb } from '$lib/server/db';
import { demoProject } from '$lib/server/db/schema';

/**
 * All-time demo accounting over the control-plane `demo_project` log.
 *
 * A demo leaves no other trace for long: its Durable Object self-erases after
 * DEMO_TTL_HOURS and its auth events age out of Analytics Engine at 90 days.
 * This log is written once per minted demo id and never pruned, so its row
 * count IS the number of demos ever created.
 *
 * Nothing in the app reads it since /admin was removed. Read it directly, which
 * needs the Cloudflare credentials that a fleet dashboard used to need a
 * password for:
 *
 *   npx wrangler d1 execute cloudflarebase-control-plane --remote \
 *     --command "select count(*) as demos from demo_project"
 *
 * `absorbFleetDemos` lived here too and is gone with /admin: it back-filled
 * pre-log history from the fleet overview's event-derived listing, which no
 * longer exists. Whatever it had already folded in stays in the table, so the
 * all-time number keeps counting from where it was.
 */

/**
 * Records a freshly minted demo project id. Best-effort by design: the demo
 * redirect must never fail or wait on accounting, so callers hand this to
 * `platform.ctx.waitUntil` and every failure path resolves silently.
 */
export async function recordDemoProject(
	platform: App.Platform | undefined,
	projectId: string
): Promise<void> {
	try {
		const db = await getDb(platform);
		await db.insert(demoProject).values({ id: projectId }).onConflictDoNothing();
	} catch {
		// Losing one log row is acceptable; breaking the demo handoff is not.
	}
}
