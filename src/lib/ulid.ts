/**
 * ULID for ids the dashboard mints itself - today, a document saved with the
 * id field left blank.
 *
 * Deliberately a small copy of `agents/db/src/ulid.ts` rather than an import:
 * the agents are separate npm projects, and the same copy-not-import rule the
 * DTO mirrors follow applies here. Keep the two in sync if the format ever
 * changes (26 chars, Crockford base32, millisecond timestamp first, so ids
 * sort chronologically).
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;

export function ulid(now: number = Date.now()): string {
	let time = now;
	let stamp = '';
	for (let i = TIME_LENGTH - 1; i >= 0; i -= 1) {
		stamp = ENCODING[time % 32] + stamp;
		time = Math.floor(time / 32);
	}
	const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_LENGTH));
	const random = Array.from(bytes, (byte) => ENCODING[byte % 32]).join('');
	return stamp + random;
}
