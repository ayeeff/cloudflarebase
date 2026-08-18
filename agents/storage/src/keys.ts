/**
 * Object-key validation and the per-project R2 prefix.
 *
 * The shared bucket's layout is `p/<projectId>/<bucket>/<key>` - project id
 * first, so the entire project is one `list({ prefix })` at erase time. The
 * prefix is the ONLY tenant boundary inside the bucket, so everything here is
 * a security check, not tidiness:
 *
 * - bucket names are validated to a slash-free charset (schemas.ts), so the
 *   bucket segment can never escape,
 * - user keys refuse `.`/`..` segments, empty segments, and leading/trailing
 *   slashes - R2 treats keys as opaque bytes, but every HTTP layer between
 *   the client and us may normalize dot segments, and a key that means one
 *   thing to the router and another to R2 is exactly how a request crosses
 *   into a sibling tenant's prefix,
 * - control characters are refused (header injection via echoed metadata),
 * - the full prefixed key must stay under R2's 1024-byte ceiling.
 *
 * Callers get the normalized key back from `parseObjectKey` and must use THAT
 * - never the raw path - when talking to R2 or the index.
 */

/** R2's hard ceiling on key length, in UTF-8 bytes. */
const R2_MAX_KEY_BYTES = 1024;
/** `p/` + projectId(<=48) + `/` + bucket(<=63) + `/` = at most 115 bytes. */
const PREFIX_BUDGET_BYTES = 2 + 48 + 1 + 63 + 1;
export const MAX_KEY_BYTES = R2_MAX_KEY_BYTES - PREFIX_BUDGET_BYTES;

const encoder = new TextEncoder();

export type KeyResult = { ok: true; key: string } | { ok: false; error: string };

/**
 * Validates one user-supplied object key (already URL-decoded by the caller).
 * Returns the exact key to store under - deliberately NOT a fixup pass: a key
 * that needs repair is refused, so the key a client wrote is always the key it
 * reads back.
 */
export function parseObjectKey(raw: string): KeyResult {
	if (!raw) return { ok: false, error: 'object keys cannot be empty' };
	if (raw.startsWith('/') || raw.endsWith('/')) {
		return { ok: false, error: 'object keys cannot start or end with "/"' };
	}
	// eslint-disable-next-line no-control-regex
	if (/[\x00-\x1f\x7f]/.test(raw)) {
		return { ok: false, error: 'object keys cannot contain control characters' };
	}
	const segments = raw.split('/');
	for (const segment of segments) {
		if (segment === '') return { ok: false, error: 'object keys cannot contain empty segments' };
		if (segment === '.' || segment === '..') {
			return { ok: false, error: 'object keys cannot contain "." or ".." segments' };
		}
	}
	if (encoder.encode(raw).length > MAX_KEY_BYTES) {
		return { ok: false, error: `object keys are limited to ${MAX_KEY_BYTES} bytes` };
	}
	return { ok: true, key: raw };
}

/**
 * The R2 key for a project's object. `projectId` and `bucket` must already be
 * schema-validated (slash-free by grammar); `key` must come from
 * `parseObjectKey`. The composed key is the tenant boundary - nothing else in
 * the system may write to the shared bucket.
 */
export function r2ObjectKey(projectId: string, bucket: string, key: string): string {
	return `p/${projectId}/${bucket}/${key}`;
}

/** Every key the project owns - the erase drain's prefix. */
export function r2ProjectPrefix(projectId: string): string {
	return `p/${projectId}/`;
}

/** Every key a bucket owns - bucket delete and reconcile walk this. */
export function r2BucketPrefix(projectId: string, bucket: string): string {
	return `p/${projectId}/${bucket}/`;
}
