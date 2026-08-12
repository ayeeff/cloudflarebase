import { consoleAuthConfig, consoleOwnerExists } from '$lib/server/console';
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** Same-origin paths only - never let ?next= drive an open redirect. */
function safeNext(value: string | null): string {
	if (!value || !value.startsWith('/') || value.startsWith('//')) return '/dashboard';
	return value;
}

/**
 * The console sign-in page. Sign-in, first-run owner claim, and - when the
 * console reports open sign-ups - registration all POST from the browser to
 * the same-origin proxy at /api/projects/console/auth/*, which relays Better
 * Auth's Set-Cookie headers back unchanged - so this loader only decides
 * which forms to offer, from the console's own /config.
 */
export const load: PageServerLoad = async ({ locals, platform, url }) => {
	const next = safeNext(url.searchParams.get('next'));
	if (locals.consoleUser) redirect(303, next);

	const [ownerExists, authConfig] = await Promise.all([
		consoleOwnerExists(platform, url.origin),
		consoleAuthConfig(platform, url.origin)
	]);

	return {
		next,
		ownerExists,
		socialProviders: authConfig.socialProviders,
		consoleSignups: authConfig.consoleSignups,
		demoMode: locals.demoMode
	};
};
