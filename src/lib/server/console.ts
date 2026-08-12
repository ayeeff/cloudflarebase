import * as Sentry from '@sentry/sveltekit';
import { CONSOLE_PROJECT_ID, type ConsoleIdentity } from '$lib/console';
import { agentUrl, requireAuthAgent } from '$lib/server/auth-agent';
import { z } from 'zod';

export type { ConsoleIdentity } from '$lib/console';

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
	providers: z.array(z.string()),
	consoleSignups: z.enum(['claimed', 'open']).default('claimed')
});

export interface ConsoleAuthConfig {
	/** Social providers the sign-in form can offer (google/github only). */
	socialProviders: string[];
	/** The console's EFFECTIVE registration policy, for honest /login copy. */
	consoleSignups: 'claimed' | 'open';
}

/**
 * The console auth instance's public /config, narrowed to what the login page
 * needs: which social buttons to offer and whether public sign-up is open
 * (docs/managed-service-design.md - the agent reports the effective mode, so
 * a misconfigured `open` never renders a doomed sign-up form).
 */
export async function consoleAuthConfig(
	platform: App.Platform | undefined,
	origin: string
): Promise<ConsoleAuthConfig> {
	const agent = requireAuthAgent(platform);
	const response = await agent
		.fetch(agentUrl(origin, CONSOLE_PROJECT_ID, '/config'))
		.catch(() => null);

	const fallback: ConsoleAuthConfig = { socialProviders: [], consoleSignups: 'claimed' };
	if (!response || !response.ok) return fallback;

	const body = await (response as unknown as Response).json().catch(() => null);
	const parsed = consoleConfigSchema.safeParse(body);
	if (!parsed.success) return fallback;
	return {
		socialProviders: parsed.data.providers.filter(
			(name) => name === 'google' || name === 'github'
		),
		consoleSignups: parsed.data.consoleSignups
	};
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

const consoleIdentitySchema = z
	.object({
		user: z.object({
			id: z.string().min(1),
			email: z.email(),
			name: z.string().default(''),
			role: z.string().default('user'),
			emailVerified: z.boolean().default(false)
		}),
		session: z.object({ activeOrganizationId: z.string().nullable().default(null) }),
		organizations: z.array(
			z.object({
				id: z.string().min(1),
				name: z.string(),
				slug: z.string(),
				role: z.string().default('member')
			})
		),
		pendingInvitations: z
			.array(
				z.object({
					id: z.string().min(1),
					organizationId: z.string(),
					organizationName: z.string(),
					role: z.string().nullable().default(null),
					inviterEmail: z.string().nullable().default(null),
					expiresAt: z.string()
				})
			)
			.default([])
	})
	.nullable();

/**
 * Resolves the operator's identity - session AND org memberships - in one
 * agent round trip via GET /console/me. This is what the per-request guard
 * uses: ownership checks need memberships, and the dashboard must never pay
 * two RPCs per request (memoized as `locals.consoleIdentity`).
 *
 * A 404 falls back to the plain session lookup with no memberships: an agent
 * deployed before /console/me existed must degrade to the pre-ownership
 * behaviour (null org visibility), never sign every operator out.
 */
export async function getConsoleIdentity(
	platform: App.Platform | undefined,
	origin: string,
	cookie: string | null,
	authorization: string | null = null
): Promise<ConsoleIdentity | null> {
	if (!cookie && !authorization) return null;

	const headers: [string, string][] = [['origin', origin]];
	if (cookie) headers.push(['cookie', cookie]);
	if (authorization) headers.push(['authorization', authorization]);

	const agent = requireAuthAgent(platform);
	const response = await agent
		.fetch(agentUrl(origin, CONSOLE_PROJECT_ID, '/console/me'), { method: 'GET', headers })
		.catch((cause: unknown) => {
			Sentry.captureException(cause, {
				level: 'error',
				tags: { operation: 'console-identity' },
				extra: { note: 'operators are being signed out - the console guard cannot verify' }
			});
			return null;
		});

	if (!response) return null;
	if (response.status === 404) {
		const user = await getConsoleSession(platform, origin, cookie, authorization);
		if (!user) return null;
		return {
			user: { ...user, emailVerified: false },
			activeOrganizationId: null,
			organizations: [],
			pendingInvitations: []
		};
	}
	if (!response.ok) {
		if (response.status !== 401 && response.status !== 403) {
			Sentry.captureMessage(`console identity lookup responded ${response.status}`, {
				level: 'error',
				tags: { operation: 'console-identity' }
			});
		}
		return null;
	}

	const body: unknown = await (response as unknown as Response).json().catch(() => undefined);
	if (body === null) return null;
	const parsed = consoleIdentitySchema.safeParse(body);
	if (!parsed.success || !parsed.data) {
		Sentry.captureMessage('console identity response did not match the expected shape', {
			level: 'error',
			tags: { operation: 'console-identity' }
		});
		return null;
	}

	const { user, session, organizations, pendingInvitations } = parsed.data;
	return {
		user: { ...user, name: user.name || user.email, emailVerified: user.emailVerified },
		activeOrganizationId: session.activeOrganizationId,
		organizations,
		pendingInvitations
	};
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
