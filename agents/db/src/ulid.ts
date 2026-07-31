/**
 * ULIDs for auto-generated document ids, replacing UUIDv4.
 *
 * Documents are stored and paged in id order, so a lexicographically
 * sortable id makes the default ordering chronological for free: exports,
 * cursor pages, and the dashboard browser all come back oldest-first without
 * an orderBy, which random UUIDs could never give. 48-bit millisecond
 * timestamp + 80 bits of randomness, Crockford base32, 26 characters -
 * inside `documentIdSchema`'s [A-Za-z0-9_-]{1,64}.
 *
 * Monotonic within a millisecond: a burst of writes in the same tick
 * increments the random component instead of re-rolling it, so ids stay
 * ordered by creation even at DO speed. Pure module, no Workers imports.
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (no I, L, O, U)
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(time: number): string {
	let out = '';
	for (let i = TIME_LENGTH - 1; i >= 0; i -= 1) {
		out = ENCODING[time % 32] + out;
		time = Math.floor(time / 32);
	}
	return out;
}

function randomChars(): number[] {
	const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_LENGTH));
	// One base32 symbol per byte: 5 bits of each, which is what keeps the
	// increment below trivial (no cross-byte carries to unpack).
	return Array.from(bytes, (byte) => byte % 32);
}

/** Increment the random component, carrying left; overflow re-rolls. */
function incrementRandom(chars: number[]): number[] {
	const next = [...chars];
	for (let i = next.length - 1; i >= 0; i -= 1) {
		if (next[i] < 31) {
			next[i] += 1;
			return next;
		}
		next[i] = 0;
	}
	return randomChars();
}

export function ulid(now: number = Date.now()): string {
	if (now === lastTime) {
		lastRandom = incrementRandom(lastRandom);
	} else {
		lastTime = now;
		lastRandom = randomChars();
	}
	return encodeTime(now) + lastRandom.map((value) => ENCODING[value]).join('');
}
