/**
 * `.assetsignore` support for managed deploys.
 *
 * Cloudflare's framework adapters write one into their output directory
 * (SvelteKit's adapter-cloudflare emits `_worker.js`, `_routes.json`,
 * `_headers`, `_redirects`), and wrangler honours it when IT uploads assets.
 * A managed deploy uploads through us instead, so ignoring the file meant
 * publishing the customer's SERVER bundle as a public asset - fetchable at
 * `/_worker.js` on their site. This is the wrangler-compatible subset:
 * gitignore-style lines, `*`/`**`/`?` wildcards, `#` comments. Negation is
 * not supported - a line starting with `!` is skipped rather than guessed at.
 */

const RESERVED_ROOT_FILES = new Set(['_worker.js', '_routes.json', '_headers', '_redirects']);

export interface AssetFilter {
	/** True when `path` (root-relative, no leading slash) must not deploy. */
	ignores(path: string): boolean;
}

function patternToRegex(pattern: string): RegExp | null {
	// Directory patterns match everything under them; root-anchored patterns
	// (any with a slash) match from the top, bare names match at any depth.
	const dirOnly = pattern.endsWith('/');
	let body = dirOnly ? pattern.slice(0, -1) : pattern;
	const anchored = body.includes('/');
	body = body.replace(/^\//, '').replace(/^\*\*\//, '');
	if (!body) return null;

	// Split on `**` first so it never collides with the single-`*` rewrite.
	const escaped = body
		.split('**')
		.map((piece) =>
			piece
				.replace(/[.+^${}()|[\]\\]/g, '\\$&')
				.replace(/\*/g, '[^/]*')
				.replace(/\?/g, '[^/]')
		)
		.join('.*');
	const prefix = anchored ? '^' : '(?:^|/)';
	// A match is the entry itself or anything beneath it (files under an
	// ignored directory are ignored with it).
	return new RegExp(`${prefix}${escaped}(?:$|/)`);
}

/**
 * Parses `.assetsignore` content into a filter. The four Cloudflare
 * convention files are ALWAYS ignored at the root, ignore file or not: they
 * are deploy configuration, never content - `_worker.js` doubly so.
 */
export function assetFilter(ignoreFileContent: string | null): AssetFilter {
	const patterns: RegExp[] = [];
	for (const rawLine of (ignoreFileContent ?? '').split('\n')) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#') || line.startsWith('!')) continue;
		const regex = patternToRegex(line);
		if (regex) patterns.push(regex);
	}
	return {
		ignores(path: string): boolean {
			if (RESERVED_ROOT_FILES.has(path)) return true;
			return patterns.some((pattern) => pattern.test(path));
		}
	};
}
