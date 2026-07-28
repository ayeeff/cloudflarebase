import { getDb } from '$lib/server/db';
import { demoProject } from '$lib/server/db/schema';
import { count } from 'drizzle-orm';

/**
 * All-time demo accounting over the control-plane `demo_project` log.
 *
 * The live fleet view on /admin only sees demos that still exist somewhere -
 * their Durable Object (erased after DEMO_TTL_HOURS) or their auth events
 * (Analytics Engine keeps 90 days). This log is written once per minted demo
 * id and never pruned, so its count is the number of demos ever created.
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

/** All-time count of minted demo projects; null when the log is unreadable. */
export async function countDemoProjectsAllTime(
	platform: App.Platform | undefined
): Promise<number | null> {
	try {
		const db = await getDb(platform);
		const [row] = await db.select({ total: count() }).from(demoProject);
		return row?.total ?? 0;
	} catch {
		return null;
	}
}
