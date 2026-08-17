import { z } from 'zod';

// 48 characters, mirrored in agents/auth and agents/db (keep all three in
// sync). The ceiling is a readability budget, not a platform limit - it was 32
// until branch ids (`<root>--<branch>`) left long-named roots with room for a
// 5-character branch.
export const projectIdSchema = z
	.string()
	.regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'Use lowercase letters, numbers, and hyphens only.');

export const signUpSchema = z
	.object({
		name: z.string().trim().min(2, 'Enter at least 2 characters.').max(80),
		email: z.email('Enter a valid email address.'),
		password: z.string().min(8, 'Password must be at least 8 characters.').max(128)
	})
	.meta({ id: 'SignUpRequest' });

export const signInSchema = z
	.object({
		email: z.email('Enter a valid email address.'),
		password: z.string().min(1, 'Enter your password.').max(128)
	})
	.meta({ id: 'SignInRequest' });

// Mirrors chatRequestSchema in agents/auth/src/schemas.ts.
export const chatRequestSchema = z
	.object({
		question: z.string().trim().min(1, 'Ask a question.').max(500)
	})
	.meta({ id: 'ChatRequest' });

// Mirrors createProjectRequestSchema in agents/auth/src/schemas.ts.
export const createProjectSchema = z
	.object({
		id: projectIdSchema.describe("Becomes the project's Durable Object name and API base path."),
		name: z.string().trim().min(1, 'Enter a name.').max(64)
	})
	.meta({ id: 'CreateProjectRequest' });

// Mirrors branchNameSchema in src/lib/server/registry.ts - keep both in sync.
// The registry adds the server-only checks (no `--`, combined 32-char ceiling,
// reserved roots) with the same first-line grammar.
export const createBranchSchema = z
	.object({
		branch: z
			.string()
			.regex(/^[a-z0-9][a-z0-9-]{0,15}$/, 'Use lowercase letters, numbers, and hyphens only.')
			.describe('Appended to the root id as `<root>--<branch>` - the branch project id.')
	})
	.meta({ id: 'CreateBranchRequest' });

// Mirrors the AuthAgent's rules in agents/auth/src/schemas.ts - keep both in sync
// so requests that pass here are never rejected by the agent with a vaguer error.
export const allowedOriginSchema = z
	.string()
	.max(2048)
	.refine((value) => {
		try {
			const url = new URL(value);
			const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
			return (
				(url.protocol === 'https:' || (local && url.protocol === 'http:')) && url.origin === value
			);
		} catch {
			return false;
		}
	}, 'Must be an exact origin like https://app.example.com - HTTPS required except for localhost.');

const providerCredentialsSchema = z.union([
	z.object({ preserve: z.literal(true) }),
	z.object({
		clientId: z.string().trim().min(1, 'Enter the client ID.').max(512),
		clientSecret: z.string().trim().min(1, 'Enter the client secret.').max(512)
	})
]);

export const settingsPayloadSchema = z
	.object({
		allowedOrigins: z.array(allowedOriginSchema).max(10, 'Add at most 10 origins.'),
		// Optional, not defaulted: an omitted socialProviders must stay omitted so the
		// agent preserves stored credentials instead of clearing them.
		socialProviders: z
			.object({
				google: providerCredentialsSchema.optional(),
				github: providerCredentialsSchema.optional()
			})
			.strict()
			.optional(),
		// Per-project auth policy (mirrors authPolicySchema in the agent).
		// Optional for the same reason: an omitted policy is unchanged.
		authPolicy: z
			.object({
				allowAnonymous: z.boolean().optional(),
				requireEmailVerification: z.boolean().optional()
			})
			.strict()
			.optional()
	})
	.meta({ id: 'SettingsRequest' });

// Mirrors roleRequestSchema/rolesRequestSchema in agents/auth/src/schemas.ts.
export const roleSlugSchema = z
	.string()
	.trim()
	.regex(/^[a-z][a-z0-9-]{0,31}$/, 'Use 1–32 lowercase letters, digits, or dashes.');
export const permissionKeySchema = z
	.string()
	.trim()
	.max(64)
	.regex(
		/^(\*|[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)*)$/,
		'Use resource:action keys like posts:write, or * for everything.'
	);
export const roleUpdateSchema = z
	.object({ role: roleSlugSchema })
	.meta({ id: 'RoleUpdateRequest' });
export const rolesUpdateSchema = z
	.object({
		roles: z
			.array(z.object({ name: roleSlugSchema, permissions: z.array(permissionKeySchema).max(50) }))
			.max(20)
	})
	.meta({ id: 'RolesUpdateRequest' });

/**
 * Admin user management (docs/admin-sdk-design.md 5.2). Mirrors the agent's
 * createUser/updateUser/setPassword schemas in agents/auth/src/schemas.ts -
 * deliberate copies, kept in sync by hand like every other DTO here.
 */
export const createUserSchema = z
	.object({
		email: z.email(),
		/** Omitted creates an account with NO credential - an invite-first or
		 * social-only user, which a later password set gives a credential to. */
		password: z.string().min(8).max(128).optional(),
		name: z.string().trim().min(1).max(128).optional(),
		/** False by default: an account is not verified merely because an admin
		 * created it. */
		emailVerified: z.boolean().optional()
	})
	.meta({ id: 'CreateUserRequest' });

export const updateUserSchema = z
	.object({
		name: z.string().trim().min(1).max(128).optional(),
		email: z.email().optional(),
		emailVerified: z.boolean().optional()
	})
	// `role` is deliberately absent - PUT /admin/users/:id/role is the only
	// writer, so the console's lockout guards cannot be sidestepped here.
	.meta({ id: 'UpdateUserRequest' });

export const setPasswordSchema = z
	.object({
		newPassword: z.string().min(8).max(128),
		/** Sessions die by default: setting a password is how an account is
		 * recovered and how one is stolen. */
		revokeSessions: z.boolean().optional()
	})
	.meta({ id: 'SetPasswordRequest' });

export type SignUpInput = z.infer<typeof signUpSchema>;
export type SignInInput = z.infer<typeof signInSchema>;
