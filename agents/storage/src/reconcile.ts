/**
 * The index reconcile walk ("Index consistency").
 *
 * R2 owns the bytes; the index is derived. Writes and deletes both hit R2
 * first and record afterwards, so an interrupted request can only leave the
 * benign shapes: a row for an object that is gone (a phantom, which a later
 * GET prunes) or - on the multipart path - an object no row counts. This walk
 * is the CRASH BACKSTOP for both, not the consistency mechanism.
 *
 * It is a streaming MERGE JOIN of two key-ordered streams, R2's listing
 * against the index scanned in key order, so memory stays one page deep
 * whatever the bucket holds. Extracted as a pure generator over two async
 * iterables precisely so it can be unit-tested: an orphan cannot be staged
 * through any public surface (that is the point of the surface), so e2e could
 * never construct the state this exists to repair.
 */

export interface ReconcileEntry {
	key: string;
	size: number;
	etag: string;
	contentType: string;
	owner: string;
	/** When the object landed in R2, or when the row was last written. */
	at: number;
}

export type ReconcileAction =
	{ kind: 'adopt'; entry: ReconcileEntry } | { kind: 'prune'; key: string };

/**
 * Anything younger than this is left alone, object AND row. A write landing
 * mid-walk reads as divergence to whichever stream was read first, so the
 * grace window turns that race into a no-op rather than a delete of live
 * data. In-flight multipart uploads never appear in `list()` at all, so the
 * walk is blind to them by construction.
 */
export const RECONCILE_GRACE_MS = 60 * 60 * 1000;

/**
 * Diff two key-ordered streams into the actions that would make them agree.
 *
 * Both iterables MUST be ascending by key - which is what makes this one pass
 * with no set held in memory. R2 lists lexicographically and the index is
 * scanned with `ORDER BY key`, so both already are.
 */
export async function* reconcileActions(
	stored: AsyncIterable<ReconcileEntry>,
	indexed: AsyncIterable<ReconcileEntry>,
	now: number,
	graceMs: number = RECONCILE_GRACE_MS,
): AsyncGenerator<ReconcileAction> {
	const left = stored[Symbol.asyncIterator]();
	const right = indexed[Symbol.asyncIterator]();
	let a = await left.next();
	let b = await right.next();

	const settled = (entry: ReconcileEntry) => now - entry.at >= graceMs;

	while (!a.done || !b.done) {
		if (a.done) {
			// Rows past the end of the listing: the object is gone.
			if (settled(b.value)) yield { kind: 'prune', key: b.value.key };
			b = await right.next();
			continue;
		}
		if (b.done) {
			// Objects past the end of the index: nothing counts them.
			if (settled(a.value)) yield { kind: 'adopt', entry: a.value };
			a = await left.next();
			continue;
		}
		if (a.value.key === b.value.key) {
			a = await left.next();
			b = await right.next();
			continue;
		}
		if (a.value.key < b.value.key) {
			if (settled(a.value)) yield { kind: 'adopt', entry: a.value };
			a = await left.next();
		} else {
			if (settled(b.value)) yield { kind: 'prune', key: b.value.key };
			b = await right.next();
		}
	}
}
