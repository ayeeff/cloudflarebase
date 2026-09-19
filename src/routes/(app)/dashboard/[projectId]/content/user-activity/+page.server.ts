import { geoAstroFetch } from '$lib/server/geo-astro';
import { assertProjectId, requireAuthAgent, agentUrl } from '$lib/server/auth-agent';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, url, platform }) => {
	const projectId = assertProjectId(params.projectId);

	let visitsData: any = { ok: true, totalVisits: 0, usersCount: 0, users: [], recentVisits: [] };
	try {
		const res = await geoAstroFetch(platform, '/api/admin/user-visits');
		if (res.ok) {
			visitsData = await res.json();
		}
	} catch (e) {
		console.error('Failed to fetch user visits from geo-astro:', e);
	}

	let registeredUsers: any[] = [];
	try {
		const agent = requireAuthAgent(platform);
		const overviewRes = await agent.fetch(agentUrl(url.origin, projectId, '/overview'));
		if (overviewRes.ok) {
			const overview: any = await overviewRes.json();
			registeredUsers = overview.users || [];
		}
	} catch (e) {
		// auth-agent might not be reached or demo
	}

	return {
		projectId,
		totalVisits: visitsData.totalVisits || 0,
		usersCount: visitsData.usersCount || 0,
		users: visitsData.users || [],
		recentVisits: visitsData.recentVisits || [],
		registeredUsers
	};
};
