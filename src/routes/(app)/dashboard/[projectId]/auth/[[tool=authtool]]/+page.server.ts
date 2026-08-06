import type { AuthAnalytics, AuthOverview } from '$lib/agents';
import { signInSchema, signUpSchema } from '$lib/schemas/auth';
import { serverError } from '$lib/server/agents';
import { agentUrl, assertProjectId, requireAuthAgent } from '$lib/server/auth-agent';
import { redirect } from '@sveltejs/kit';
import { superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import type { PageServerLoad } from './$types';

/** Pre-split deep links used ?tab=; the tool is a route segment now. */
const LEGACY_TABS: Record<string, string> = {
	sessions: 'sessions',
	roles: 'roles',
	settings: 'settings',
	playground: 'playground',
	setup: 'integration'
};

export const load: PageServerLoad = async ({ params, url, platform }) => {
	const projectId = assertProjectId(params.projectId);

	if (!params.tool) {
		const legacy = LEGACY_TABS[url.searchParams.get('tab') ?? ''];
		if (legacy) redirect(308, `/dashboard/${projectId}/auth/${legacy}`);
	}

	const agent = requireAuthAgent(platform);

	const [overviewRes, analyticsRes] = await Promise.all([
		agent.fetch(agentUrl(url.origin, projectId, '/overview')),
		agent.fetch(agentUrl(url.origin, projectId, '/analytics'))
	]);
	if (!overviewRes.ok || !analyticsRes.ok) {
		serverError(502, `auth agent responded with ${overviewRes.status}/${analyticsRes.status}`);
	}

	return {
		projectId,
		overview: (await overviewRes.json()) as AuthOverview,
		analytics: (await analyticsRes.json()) as AuthAnalytics,
		// Forms start empty; the playground's "New identity" dice fills demo values.
		signUpForm: await superValidate(zod4(signUpSchema), { id: 'sign-up' }),
		signInForm: await superValidate(zod4(signInSchema), { id: 'sign-in' })
	};
};
