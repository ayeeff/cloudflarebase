import * as Sentry from '@sentry/sveltekit';
import { CONSOLE_PROJECT_ID } from '$lib/console';
import { agentUrl, requireAuthAgent } from '$lib/server/auth-agent';
import { z } from 'zod';

/**
 * The console authenticates its operators against a dedicated AuthAgent - the
 * same stack every customer project runs. Cloudflarebase's own dashboard is
 * therefore its first customer.
 *
 * The instance is addressed by a reserved project id, so the registry must
 * never hand it out (see RESERVED_PROJECT_IDS in $lib/console).
 */
export { CONSOLE_PROJECT_ID, RESERVED_PROJECT_IDS, isDemoProjectId } from '$lib/console';

/**
 * Demo mode is what keeps cloudflarebase.com open to the public while every
 * self-hosted install is closed by default. It is opt-in: an unset DEMO_MODE
 * means a private console, which is the safe default for someone who just
 * deployed this to their own account.
 */
export function isDemoMode(platform: App.Platform | undefined): boolean {
	return platform?.env?.DEMO_MODE === 'true';
}

/**
 * Better Auth's get-session payload, narrowed to what the console needs. Parsed
 * rather than cast: this crosses a service binding, so it is untrusted input.
 */
const consoleSessionSchema = z.object({
	user: z.object({
		id: z.string().min(1),
		email: z.email(),
		name: z.string().default(''),
		role: z.string().default('user')
	})
});

const consoleOverviewSchema = z.object({
	users: z.array(z.unknown())
});

const consoleConfigSchema = z.object({
	providers: z.array(z.string())
});

/**
 * Social providers configured on the console's own auth instance, so the login
 * page can offer the matching buttons. Reads the same public /config the
 * integration tab uses; only google/github are actionable on the sign-in form.
 */
export async function consoleSocialProviders(
	platform: App.Platform | undefined,
	origin: string
): Promise<string[]> {
	const agent = requireAuthAgent(platform);
	const response = await agent
		.fetch(agentUrl(origin, CONSOLE_PROJECT_ID, '/config'))
		.catch(() => null);

	if (!response || !response.ok) return [];

	const body = await (response as unknown as Response).json().catch(() => null);
	const parsed = consoleConfigSchema.safeParse(body);
	if (!parsed.success) return [];
	return parsed.data.providers.filter((name) => name === 'google' || name === 'github');
}

export type ConsoleUser = z.infer<typeof consoleSessionSchema>['user'];

/**
 * Resolves the operator session by asking the console's AuthAgent, forwarding
 * the browser's cookies - and, for the CLI, a bearer `Authorization` header
 * (the agent accepts session tokens as bearers; that is the documented
 * external-client path on every project instance, the console included).
 * Returns null when there is no valid session.
 *
 * This runs on the hot path for dashboard polling, so callers should memoize
 * per request (see `locals.consoleUser` in hooks.server.ts).
 */
export async function getConsoleSession(
	platform: App.Platform | undefined,
	origin: string,
	cookie: string | null,
	authorization: string | null = null
): Promise<ConsoleUser | null> {
	if (!cookie && !authorization) return null;

	const headers: [string, string][] = [['origin', origin]];
	if (cookie) headers.push(['cookie', cookie]);
	if (authorization) headers.push(['authorization', authorization]);

	const agent = requireAuthAgent(platform);
	const response = await agent
		.fetch(agentUrl(origin, CONSOLE_PROJECT_ID, '/api/auth/get-session'), {
			method: 'GET',
			headers
		})
		.catch((cause: unknown) => {
			// Failing closed is right, but silence is not: an unreachable auth
			// agent logs EVERY operator out, and that must not look like a
			// pile of expired cookies.
			Sentry.captureException(cause, {
				level: 'error',
				tags: { operation: 'console-session' },
				extra: { note: 'operators are being signed out - the console guard cannot verify' }
			});
			return null;
		});

	if (!response) return null;
	// 401/403 is the ordinary "not signed in" answer; anything else is broken.
	if (!response.ok) {
		if (response.status !== 401 && response.status !== 403) {
			Sentry.captureMessage(`console session lookup responded ${response.status}`, {
				level: 'error',
				tags: { operation: 'console-session' }
			});
		}
		return null;
	}

	const body: unknown = await (response as unknown as Response).json().catch(() => undefined);
	// Better Auth answers a signed-out get-session with 200 and a JSON null
	// body - the ORDINARY case for any visitor carrying unrelated cookies
	// (e.g. the demo-project cookie), not a contract drift. Only a 200 whose
	// body is neither null nor the session shape means the contract moved.
	if (body === null) return null;
	const parsed = consoleSessionSchema.safeParse(body);
	if (!parsed.success) {
		// A valid 200 the guard cannot read means the session contract drifted.
		Sentry.captureMessage('console session response did not match the expected shape', {
			level: 'error',
			tags: { operation: 'console-session' }
		});
		return null;
	}

	const { user } = parsed.data;
	return { ...user, name: user.name || user.email };
}

/**
 * Whether the console has been claimed. Drives first-run setup: while this is
 * false the login page offers owner creation, and the agent permits exactly
 * one sign-up on the console project.
 */
export async function consoleOwnerExists(
	platform: App.Platform | undefined,
	origin: string
): Promise<boolean> {
	const agent = requireAuthAgent(platform);
	const response = await agent
		.fetch(agentUrl(origin, CONSOLE_PROJECT_ID, '/overview'))
		.catch(() => null);

	if (!response || !response.ok) return false;

	const body = await (response as unknown as Response).json().catch(() => null);
	const parsed = consoleOverviewSchema.safeParse(body);
	return parsed.success && parsed.data.users.length > 0;
}
