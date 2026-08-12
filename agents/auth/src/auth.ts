import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { anonymous, bearer, jwt, organization } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import * as schema from './db/schema';

export type AuthDatabase = DrizzleSqliteDODatabase<typeof schema>;

export interface AuthHookUser {
	id: string;
	email: string;
	name: string;
	isAnonymous?: boolean | null;
}

export interface AuthEmailMessage {
	type: 'email-verification' | 'password-reset' | 'invitation';
	to: string;
	url: string;
	/** Extra copy for invitation mail: who invited, into which organization. */
	invitation?: { organization: string; inviter: string };
}

/**
 * Creates the user's personal organization if they belong to none - every
 * account lands with one org it owns, so "personal project" is just an org
 * with a single member and ownership never needs a user-or-org union type.
 * Called from the user-creation hook when `autoPersonalOrg` is on, and again
 * lazily from the console's /console/me so accounts that predate organizations
 * (the first-run owner) heal on their next visit. Anonymous users never get
 * one. Safe to call repeatedly: Durable Object input gates serialize the
 * check-then-insert, so no duplicate personal org can be minted.
 */
export async function ensurePersonalOrg(
	db: AuthDatabase,
	user: Pick<AuthHookUser, 'id' | 'email' | 'name' | 'isAnonymous'>,
): Promise<void> {
	if (user.isAnonymous) return;
	const [existing] = await db
		.select({ id: schema.member.id })
		.from(schema.member)
		.where(eq(schema.member.userId, user.id))
		.limit(1);
	if (existing) return;

	const now = new Date();
	const orgId = crypto.randomUUID();
	const owner = (user.name || user.email.split('@')[0] || 'Personal').trim();
	await db.insert(schema.organization).values({
		id: orgId,
		name: `${owner}'s organization`.slice(0, 64),
		// Random suffix, not derived from the name: slugs are unique and the
		// personal org is addressed by id everywhere that matters.
		slug: `personal-${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`,
		createdAt: now,
	});
	await db.insert(schema.member).values({
		id: crypto.randomUUID(),
		organizationId: orgId,
		userId: user.id,
		role: 'owner',
		createdAt: now,
	});
}

export interface ProjectAuthConfig {
	/** Cloudflarebase project id - one AuthAgent (and one auth database) per project. */
	projectId: string;
	/** Drizzle handle over the Durable Object's embedded SQLite database. */
	db: AuthDatabase;
	secret: string;
	/** Origins allowed to call this project's auth endpoints (CSRF protection). */
	trustedOrigins: string[];
	/** Disable throttling only in an isolated automated-test environment. */
	disableRateLimit?: boolean;
	/** Country of the request currently being handled (from request.cf). */
	getRequestCountry?: () => string | null;
	/** Resolves a role name to its granted permission keys (from agent state). */
	getRolePermissions?: (role: string) => string[];
	/** Optional Google OAuth credentials (per-project social sign-in). */
	google?: { clientId: string; clientSecret: string };
	github?: { clientId: string; clientSecret: string };
	sendEmail?: (message: AuthEmailMessage) => Promise<void>;
	/**
	 * Refuse sign-in until the email is verified (managed open sign-ups).
	 * Only meaningful with a configured sendEmail transport.
	 */
	requireEmailVerification?: boolean;
	/**
	 * Better Auth's signed cookie cache: session reads become local signature
	 * checks for 60 seconds, so a polling dashboard does not hammer the
	 * session table on every request. Enabled for the console instance.
	 */
	cookieCache?: boolean;
	/**
	 * Create a personal organization for every new registered user (see
	 * ensurePersonalOrg). On for the console instance; consumers can enable
	 * the same hook for their own products.
	 */
	autoPersonalOrg?: boolean;
	/**
	 * Veto over user creation, consulted at the database layer with the user
	 * being created. Returning a reason string rejects the creation with 403.
	 * Route-level checks cannot cover every path that creates a user - social
	 * sign-in creates one implicitly on the OAuth callback without touching
	 * any sign-up route - so an instance that must not grow (the console)
	 * enforces it here.
	 */
	denyUserCreation?: (user: Pick<AuthHookUser, 'email' | 'isAnonymous'>) => Promise<string | null>;
	onUserCreated?: (user: AuthHookUser) => void | Promise<void>;
	onSessionActivity?: (
		session: { id: string; userId: string },
		kind: 'created' | 'refreshed',
	) => void | Promise<void>;
}

/**
 * Builds the Better Auth instance for a single project. All auth tables
 * (user, session, account, verification) live inside the project's Durable
 * Object SQLite database, so every project gets a fully isolated auth stack.
 */
export function createProjectAuth(config: ProjectAuthConfig) {
	return betterAuth({
		appName: `cloudflarebase:${config.projectId}`,
		// The PUBLIC path of this project's auth endpoints on a dashboard
		// deployment, not the agent-internal /api/auth the DO dispatches on
		// (agent.ts rewrites ingress to this base). Better Auth derives every
		// absolute URL it hands out - email verification/reset links, OAuth
		// redirect URIs - from request origin + basePath, so mounting it at the
		// internal path sent visitors to a route the console guard 401s.
		basePath: `/api/projects/${config.projectId}/auth`,
		secret: config.secret,
		// A deployment trusts its own origin automatically: a browser only sends
		// an Origin equal to the URL it is actually on, so same-origin requests
		// are never CSRF. The configured list is for anything else - custom
		// domains, external apps - and a fresh install needs no configuration
		// before sign-in works.
		trustedOrigins: (request) => [
			...config.trustedOrigins,
			request ? new URL(request.url).origin : null,
		],
		database: drizzleAdapter(config.db, {
			provider: 'sqlite',
			schema,
			// DO SQLite exposes only sync transactions; run operations sequentially.
			transaction: false,
		}),
		emailAndPassword: {
			enabled: true,
			minPasswordLength: 8,
			maxPasswordLength: 128,
			revokeSessionsOnPasswordReset: true,
			// Open console sign-ups: nobody signs in until their address is
			// proven. A failed unverified sign-in re-sends the verification mail,
			// which is also how an owner from before verification existed gets
			// their link when a deployment turns this on later.
			requireEmailVerification: config.requireEmailVerification,
			sendResetPassword: config.sendEmail
				? async ({ user, url }) =>
						config.sendEmail?.({ type: 'password-reset', to: user.email, url })
				: undefined,
		},
		emailVerification: config.sendEmail
			? {
					sendOnSignUp: true,
					sendVerificationEmail: async ({ user, url }) =>
						config.sendEmail?.({ type: 'email-verification', to: user.email, url }),
				}
			: undefined,
		rateLimit: {
			enabled: !config.disableRateLimit,
			window: 60,
			max: 100,
			customRules: {
				'/sign-in/email': { window: 60, max: 10 },
				'/sign-up/email': { window: 60, max: 10 },
				'/sign-in/anonymous': { window: 60, max: 20 },
			},
		},
		// Guest sign-in (POST /sign-in/anonymous) - adds user.isAnonymous.
		plugins: [
			anonymous(),
			bearer(),
			// Teams for every project (and the console is the first user of its
			// own feature: cloudflarebase orgs are rows in the console instance).
			organization({
				// Guests can hold sessions but never own teams.
				allowUserToCreateOrganization: (user) =>
					!(user as { isAnonymous?: boolean | null }).isAnonymous,
				sendInvitationEmail: config.sendEmail
					? async (data, request) => {
							// The console surfaces pending invitations after sign-in, so
							// the link only needs to land the invitee on the login page
							// of the deployment the invite was minted from.
							const origin = request ? new URL(request.url).origin : config.trustedOrigins[0];
							await config.sendEmail?.({
								type: 'invitation',
								to: data.email,
								url: origin ? `${origin}/login` : '',
								invitation: {
									organization: data.organization.name,
									inviter: data.inviter.user.email,
								},
							});
						}
					: undefined,
			}),
			// GET /token issues a project-signed JWT (public keys on GET /jwks)
			// carrying the user's role so external services can authorize offline.
			jwt({
				jwt: {
					issuer: `cloudflarebase:${config.projectId}`,
					audience: config.projectId,
					definePayload: ({ user }) => {
						const role = (user as { role?: string }).role ?? 'user';
						return {
							email: user.email,
							role,
							permissions: config.getRolePermissions?.(role) ?? [],
						};
					},
				},
			}),
		],
		socialProviders: {
			...(config.google ? { google: config.google } : {}),
			...(config.github ? { github: config.github } : {}),
		},
		account: {
			accountLinking: {
				// Both providers attest verified emails, so implicit linking on the
				// OAuth callback already applies; trusting them additionally allows
				// EXPLICIT /link-social from a live session whose local email is
				// still unverified (linking from a session proves account ownership
				// on its own). requireLocalEmailVerified stays at its safe default:
				// relaxing it would let a pre-registered unverified password account
				// capture a later social sign-in with the same address.
				trustedProviders: ['google', 'github'],
			},
		},
		user: {
			additionalFields: {
				// Simple RBAC. input: false blocks self-assignment at sign-up; the
				// dashboard's admin route is the only writer.
				role: { type: 'string', required: false, defaultValue: 'user', input: false },
			},
		},
		session: {
			additionalFields: {
				country: { type: 'string', required: false, input: false },
			},
			// Signed cookie cache: for its lifetime a get-session is a local
			// signature check instead of a session-table read, so dashboard
			// polling stops being bounded by the one console instance's SQLite.
			// Revocations take up to maxAge to bite - keep it short.
			cookieCache: config.cookieCache ? { enabled: true, maxAge: 60 } : undefined,
		},
		advanced: {
			// Scope cookies per project so multiple project dashboards on the
			// same origin don't clobber each other's sessions.
			cookiePrefix: `cfb-${config.projectId}`,
			// Cloudflare resolves the client address at the edge and overwrites
			// any inbound attempt to spoof it. Without this, rate limiting
			// cannot see an IP and falls back to one shared per-path bucket,
			// where a single noisy client exhausts sign-in for everyone.
			ipAddress: {
				ipAddressHeaders: ['cf-connecting-ip'],
			},
		},
		databaseHooks: {
			user: {
				create: {
					before: async (user) => {
						const denied = await config.denyUserCreation?.(
							user as Pick<AuthHookUser, 'email' | 'isAnonymous'>,
						);
						if (denied) {
							throw new APIError('FORBIDDEN', { message: denied });
						}
						return { data: user };
					},
					after: async (user) => {
						if (config.autoPersonalOrg) {
							await ensurePersonalOrg(config.db, user as AuthHookUser);
						}
						await config.onUserCreated?.(user as AuthHookUser);
					},
				},
			},
			session: {
				create: {
					// Stamp the session with the country Cloudflare resolved for
					// the request that created it.
					before: async (session) => ({
						data: { ...session, country: config.getRequestCountry?.() ?? null },
					}),
					after: async (session) => {
						await config.onSessionActivity?.(session, 'created');
					},
				},
				update: {
					after: async (session) => {
						await config.onSessionActivity?.(session, 'refreshed');
					},
				},
			},
		},
	});
}

export type ProjectAuth = ReturnType<typeof createProjectAuth>;
