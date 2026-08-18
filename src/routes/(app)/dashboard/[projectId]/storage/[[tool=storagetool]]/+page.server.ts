import { AGENT_REGISTRY } from '$lib/agent-registry';
import { storageBucketSchema, storageOverviewSchema, type StorageBucketInfo } from '$lib/agents';
import {
	agentSegment,
	agentUrl,
	assertProjectId,
	requireAgent,
	serverError
} from '$lib/server/agents';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, url, platform }) => {
	const projectId = assertProjectId(params.projectId);
	const entry = AGENT_REGISTRY.storage;
	const agent = requireAgent(platform, entry);

	const response = await agent.fetch(agentUrl(url.origin, entry, projectId, '/overview'));
	if (!response.ok) {
		serverError(502, 'the storage agent is unavailable');
	}
	const overview = storageOverviewSchema.safeParse(await response.json());
	if (!overview.success) {
		serverError(502, 'the storage agent is unavailable');
	}

	// The Access page edits the FULL config - permission keys, size ceiling,
	// content-type allowlist, cache-control - and the overview carries only the
	// summary. Fetched here rather than after hydration so the controls render
	// with their real values instead of flashing defaults; bounded by the
	// 5-bucket cap, and skipped entirely on the other two pages.
	let configs: StorageBucketInfo[] | null = null;
	if (params.tool === 'access' && overview.data.configured && !overview.data.demo) {
		configs = (
			await Promise.all(
				overview.data.buckets.map(async (bucket) => {
					const each = await agent.fetch(
						agentUrl(url.origin, entry, projectId, `/admin/buckets/${agentSegment(bucket.name)}`)
					);
					if (!each.ok) return null;
					const body = (await each.json()) as { bucket?: unknown };
					const parsed = storageBucketSchema.safeParse(body.bucket);
					return parsed.success ? parsed.data : null;
				})
			)
		).filter((bucket): bucket is StorageBucketInfo => bucket !== null);
	}

	return { projectId, overview: overview.data, configs };
};
