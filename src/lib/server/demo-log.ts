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

/**
 * Absorbs fleet-visible demo projects into the log. The log shipped after the
 * first demos existed, so counting it alone would misreport history as zero:
 * /admin seeds it from the fleet overview's event-derived listing (90 days of
 * Analytics Engine memory) before counting. Idempotent and keyed on project
 * id - the first write wins, so already-logged rows keep their created_at -
 * and the all-time count can never read lower than the live fleet view.
 */
export async function absorbFleetDemos(
	platform: App.Platform | undefined,
	demos: Array<{ projectId: string; firstSeenAt: string | null }>
): Promise<void> {
	if (demos.length === 0) return;
	try {
		const db = await getDb(platform);
		const rows = demos.map((demo) => {
			const seen = demo.firstSeenAt ? new Date(demo.firstSeenAt) : null;
			return {
				id: demo.projectId,
				createdAt: seen && !Number.isNaN(seen.getTime()) ? seen : new Date()
			};
		});
		// D1 caps bound parameters per statement; two per row keeps chunks safe.
		for (let start = 0; start < rows.length; start += 40) {
			await db
				.insert(demoProject)
				.values(rows.slice(start, start + 40))
				.onConflictDoNothing();
		}
	} catch {
		// Seeding is opportunistic; the next /admin load retries.
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
