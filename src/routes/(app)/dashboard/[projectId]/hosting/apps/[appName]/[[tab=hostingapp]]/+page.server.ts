import { AGENT_REGISTRY } from '$lib/agent-registry';
import {
	hostingBuildEnvSchema,
	hostingOverviewSchema,
	hostingSecretListSchema,
	hostingVarListSchema
} from '$lib/agents';
import { isDemoProjectId } from '$lib/console';
import {
	agentSegment,
	agentUrl,
	assertProjectId,
	requireAgent,
	serverError
} from '$lib/server/agents';
import { getConnection } from '$lib/server/github-connect';
import { appNameSchema, listAppClaims } from '$lib/server/hosting';
import { getBranchContext } from '$lib/server/registry';
import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * The per-app page (the CF Workers dashboard shape): Overview, Deployments,
 * Analytics, Settings as URL tabs. One load serves them all - the pieces are
 * small, and tab switches are client-side navigations to sibling routes.
 * Analytics data is client-fetched (range changes should not re-run this).
 */
export const load: PageServerLoad = async ({ params, url, platform }) => {
	const projectId = assertProjectId(params.projectId);
	if (isDemoProjectId(projectId)) {
		// No demo hosting - the hub shows the upsell.
		redirect(303, `/dashboard/${projectId}/hosting`);
	}
	if (!appNameSchema.safeParse(params.appName).success) {
		error(404, 'no such app');
	}
	const appName = params.appName;

	const entry = AGENT_REGISTRY.hosting;
	const agent = requireAgent(platform, entry);
	const fetchAgent = async (subPath: string) => {
		const response = await agent.fetch(agentUrl(url.origin, entry, projectId, subPath));
		if (!response.ok) serverError(502, 'the hosting agent is unavailable');
		return response.json();
	};

	const overview = hostingOverviewSchema.safeParse(await fetchAgent('/overview'));
	if (!overview.success) serverError(502, 'the hosting agent is unavailable');

	// The agent only learns an app at first deploy; a claim-only app (a
	// connected repository that has not pushed yet) still gets a page.
	const deployed = overview.data.apps.find((app) => app.name === appName) ?? null;
	const claim = deployed
		? null
		: ((await listAppClaims(platform, projectId)).find((row) => row.appName === appName) ?? null);
	if (!deployed && !claim) error(404, 'no such app');
	const app = deployed ?? {
		name: appName,
		subdomain: claim!.subdomain,
		url: null,
		deployCount: 0,
		lastDeployAt: null,
		createdAt: claim!.createdAt
	};

	const segment = agentSegment(appName);
	const vars = hostingVarListSchema.safeParse(await fetchAgent(`/apps/${segment}/vars`));
	const secrets = hostingSecretListSchema.safeParse(await fetchAgent(`/apps/${segment}/secrets`));

	// Connections live on ROOT projects only; a branch page simply has no
	// build section (its build env is the root connection's).
	const context = await getBranchContext(platform, projectId);
	const isRoot = !context || context.current === null;
	const connection = isRoot ? await getConnection(platform, projectId, appName) : null;
	const buildEnv = connection
		? hostingBuildEnvSchema.safeParse(await fetchAgent(`/apps/${segment}/build-env`))
		: null;

	return {
		projectId,
		appName,
		tab: params.tab ?? 'overview',
		app,
		configured: overview.data.configured,
		stub: overview.data.stub,
		isRoot,
		connection,
		vars: vars.success ? vars.data.vars : [],
		secrets: secrets.success ? secrets.data.secrets : [],
		buildEnv: buildEnv?.success ? buildEnv.data : null
	};
};
