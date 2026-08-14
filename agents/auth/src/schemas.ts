import { z } from 'zod';

export const resourceIdSchema = z.string().min(1).max(128);
// 48 characters: branch ids are `<root>--<branch>`, so the ceiling has to hold
// a root plus a usable branch name. Mirrored in the console's
// src/lib/schemas/auth.ts and in agents/db - keep all three in sync.
export const projectIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/);

/**
 * Projects minted for anonymous visitors of the public demo. They are
 * throwaway by construction: capped, and erased on a schedule. Mirrored in the
 * app's src/lib/console.ts; keep both in sync.
 */
// Demo roots are demo-<12..20 hex>; a demo BRANCH is demo-<hex>--<branch>
// (branches-design.md), and the whole family must share demo caps and TTL
// erasure - a branch escaping this pattern would be an uncapped anonymous
// instance. Mirrored in the console's $lib/console.ts and agents/db.
export const DEMO_PROJECT_PATTERN = /^demo-[a-f0-9]{12,20}(?:--[a-z0-9][a-z0-9-]{0,15})?$/;

/** Hours a demo project survives before it erases itself. */
export const demoTtlHoursSchema = z.coerce.number().int().min(1).max(720).catch(24);

export const timeZoneSchema = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.refine((value) => {
		try {
			new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
			return true;
		} catch {
			return false;
		}
	}, 'Invalid IANA time zone');

const roleSlugSchema = z
	.string()
	.trim()
	.regex(/^[a-z][a-z0-9-]{0,31}$/, 'invalid role');

// Clerk-style permission keys: `resource:action` segments, or `*` for all.
const permissionSchema = z
	.string()
	.trim()
	.max(64)
	.regex(/^(\*|[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)*)$/, 'invalid permission');

const roleDefinitionSchema = z.strictObject({
	name: roleSlugSchema,
	permissions: z.array(permissionSchema).max(50),
});

export const roleRequestSchema = z.strictObject({ role: roleSlugSchema });

// The built-in roles always exist so assignment and the dashboard default set
// can rely on them; duplicate names collapse to the last definition.
export const rolesRequestSchema = z
	.strictObject({ roles: z.array(roleDefinitionSchema).max(20) })
	.transform(({ roles }) => {
		const byName = new Map<string, string[]>();
		byName.set('user', []);
		byName.set('admin', ['*']);
		for (const role of roles) byName.set(role.name, [...new Set(role.permissions)]);
		return { roles: [...byName].map(([name, permissions]) => ({ name, permissions })) };
	});

/**
 * Project ids the registry refuses: `console` is the operator auth instance,
 * the rest would collide with dashboard routes or read as system endpoints.
 * Mirrored in the app's src/lib/console.ts; keep both in sync.
 */
export const RESERVED_PROJECT_IDS = new Set([
	'console',
	'admin',
	'api',
	'agents',
	'auth',
	'dashboard',
	'login',
	'logout',
	'setup',
	'new',
	'health',
	'fleet',
	'organization',
]);

export const createProjectRequestSchema = z.strictObject({
	id: projectIdSchema.refine(
		(value) => !RESERVED_PROJECT_IDS.has(value),
		'that project id is reserved',
	),
	name: z.string().trim().min(1, 'name is required').max(64),
});

export const chatRequestSchema = z.strictObject({
	question: z.string().trim().min(1, 'question is required').max(500),
});

/** The local-dev direct password reset (DISABLE_EMAIL_VERIFICATION only).
 * Bounds mirror Better Auth's emailAndPassword min/max. */
export const localResetPasswordSchema = z.strictObject({
	email: z.email(),
	newPassword: z.string().min(8).max(128),
});

const allowedOriginSchema = z
	.string()
	.max(2048)
	.transform((value, context) => {
		try {
			const url = new URL(value);
			const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
			if (
				(url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
				url.origin !== value
			) {
				throw new Error('invalid origin');
			}
			return url.origin;
		} catch {
			context.addIssue({ code: 'custom', message: `invalid origin: ${value}` });
			return z.NEVER;
		}
	});

export const socialCredentialsSchema = z
	.strictObject({
		google: z
			.strictObject({
				clientId: z.string().trim().min(1).max(512),
				clientSecret: z.string().trim().min(1).max(512),
			})
			.optional(),
		github: z
			.strictObject({
				clientId: z.string().trim().min(1).max(512),
				clientSecret: z.string().trim().min(1).max(512),
			})
			.optional(),
	})
	.catch({});

const providerUpdateSchema = z.union([
	z.strictObject({ preserve: z.literal(true) }),
	z.strictObject({
		clientId: z.string().trim().min(1).max(512),
		clientSecret: z.string().trim().min(1).max(512),
	}),
]);

/**
 * Per-project authentication policy - the two switches Firebase and Supabase
 * both give a developer and this agent did not.
 *
 * Both default to today's behaviour, so no deployed project changes when this
 * ships. They are stored, not derived, because they are product decisions:
 *
 * - `allowAnonymous`: guest sign-in is a public route on every project, and
 *   a guest token satisfies the `auth` access mode - which is the DEFAULT for
 *   new collections and tables. So a project that never wanted guests had its
 *   "signed-in users only" data readable by anyone willing to ask for a guest
 *   token first. Firebase and Supabase both ship anonymous OFF.
 * - `requireEmailVerification`: without it, anyone can register a stranger's
 *   address and hold an authenticated token for it. Only meaningful with a
 *   configured sender, so the agent reports the EFFECTIVE value.
 */
export const authPolicySchema = z.strictObject({
	allowAnonymous: z.boolean().default(true),
	requireEmailVerification: z.boolean().default(false),
});

export type AuthPolicy = z.infer<typeof authPolicySchema>;

export const settingsRequestSchema = z
	.strictObject({
		allowedOrigins: z.array(allowedOriginSchema).max(10),
		socialProviders: z
			.strictObject({
				google: providerUpdateSchema.optional(),
				github: providerUpdateSchema.optional(),
			})
			.optional(),
		/** Omitted leaves the stored policy untouched, like socialProviders. */
		authPolicy: authPolicySchema.partial().optional(),
	})
	.transform((value) => ({
		...value,
		allowedOrigins: [...new Set(value.allowedOrigins)],
	}));

export const sessionActivityResponseSchema = z
	.object({
		user: z.object({ id: resourceIdSchema }),
		session: z.object({ id: resourceIdSchema }),
	})
	.nullable();

export const analyticsApiResponseSchema = z.object({ data: z.array(z.unknown()).optional() });

export const workersAiResponseSchema = z.object({ response: z.string().trim().min(1).max(20_000) });

export type SocialCredentials = z.infer<typeof socialCredentialsSchema>;
export type ProviderUpdates = NonNullable<z.infer<typeof settingsRequestSchema>['socialProviders']>;
