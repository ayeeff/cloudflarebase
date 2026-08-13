import { z } from 'zod';

/**
 * Trust-boundary schemas: strictObject for request bodies, `.catch` for
 * env/storage reads, and a schema - never a cast - for anything that crosses
 * a trust boundary.
 */

// 48 characters: branch ids are `<root>--<branch>`, so the ceiling has to hold
// a root plus a usable branch name. Mirrored in the console's
// src/lib/schemas/auth.ts and in agents/auth + agents/db - keep all four in
// sync.
export const projectIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/);

// Demo roots are demo-<12..20 hex>; a demo BRANCH is demo-<hex>--<branch>
// (branches-design.md). Hosting refuses the whole family - anonymous code
// execution is an abuse machine - so the pattern is the refusal key here,
// not a cap selector. Mirrored in the console's $lib/console.ts and the
// other agents.
export const DEMO_PROJECT_PATTERN = /^demo-[a-f0-9]{12,20}(?:--[a-z0-9][a-z0-9-]{0,15})?$/;

/** App names: subdomain charset, 3-48 chars, no `--` (mirrors the console's
 * appNameSchema - the console owns claims; this copy only guards the DO's
 * own registry keys). */
export const appNameSchema = z
	.string()
	.regex(/^[a-z0-9][a-z0-9-]{2,47}$/)
	.refine((value) => !value.includes('--'));

/** Subdomains are DNS labels: app name, optional branch and numbering. */
export const subdomainSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

/** The `meta` part of a deploy's multipart body. */
export const deployMetaSchema = z.strictObject({
	/** Part name of the Worker entry module; absent = assets-only app. */
	mainModule: z
		.string()
		.regex(/^[A-Za-z0-9._-]+\.(?:js|mjs)$/)
		.optional(),
	compatibilityDate: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional(),
	compatibilityFlags: z
		.array(z.string().regex(/^[a-z0-9_]+$/))
		.max(10)
		.optional(),
	/** Plain-text vars injected as bindings beside PROJECT_ID/CLOUDFLAREBASE_URL. */
	vars: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string().max(5000)).optional(),
	/** Static-asset serving behaviour; defaults chosen for app-shaped sites. */
	notFoundHandling: z.enum(['single-page-application', '404-page', 'none']).optional(),
});

export type DeployMeta = z.infer<typeof deployMetaSchema>;

export const secretBodySchema = z.strictObject({
	name: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
	value: z.string().min(1).max(5000),
});

/** Keyset cursor for the deploy list: `<createdAtMs>:<id>`. */
export const deployCursorSchema = z
	.string()
	.regex(/^\d{1,16}:[0-9a-f-]{36}$/)
	.optional()
	.catch(undefined);
