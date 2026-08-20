import { z } from 'zod';

/**
 * Branch filters for a GitHub connection: which pushes never deploy, and
 * which branch is production. Pure on purpose (no server imports) - the
 * webhook handler, the OIDC grant verification, and the connection PATCH all
 * import it, and `node:test` runs it directly.
 */

/** A git branch name we accept as production. Charset-limited because these
 * values are embedded into workflow YAML - quoting is a bug class, refusing
 * is not (the assetsDirSchema precedent). */
export const gitBranchSchema = z
	.string()
	.min(1)
	.max(120)
	.regex(/^[A-Za-z0-9._/-]+$/, 'branch names may use letters, digits, ., _, / and -');

/** An ignore filter: a branch name, or a simple `*` glob (`renovate/*`). */
export const branchFilterSchema = z
	.string()
	.min(1)
	.max(120)
	.regex(/^[A-Za-z0-9._/*-]+$/, 'branch filters may use letters, digits, ., _, /, - and *');

/** Tolerant parse of the `ignored_branches` D1 column - a row written by
 * hand (or a future format) degrades to "nothing ignored", never a throw. */
export function parseIgnoredBranches(json: string | null): string[] {
	if (!json) return [];
	try {
		const parsed: unknown = JSON.parse(json);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((entry): entry is string => typeof entry === 'string');
	} catch {
		return [];
	}
}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a branch matches any filter. Exact match, or `*` as "any run of
 * characters" (it crosses `/` on purpose - `release/*` matching
 * `release/1.2/hotfix` is the least surprising reading, and GitHub's own
 * `branches-ignore` treats `**` that way).
 */
export function branchIsIgnored(patterns: string[], branch: string): boolean {
	return patterns.some((pattern) => {
		if (!pattern.includes('*')) return pattern === branch;
		const regex = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`);
		return regex.test(branch);
	});
}
