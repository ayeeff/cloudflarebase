/**
 * Where does this Durable Object actually run? `/cdn-cgi/trace` answers with
 * the EXECUTING machine's colo (IATA) and country - the only self-location
 * signal a DO has, since `request.cf` always describes the caller's edge.
 * Best-effort with a short timeout: this feeds the dashboard's replication
 * map, and an unknown location must never slow an admin response down. Local
 * dev simply reports nulls.
 *
 * The isolate cache EXPIRES rather than pinning the first answer. An instance
 * is not guaranteed to stay where it started - Cloudflare has signalled DO
 * relocation - and a location cached for the life of an isolate would report
 * the old colo for as long as that isolate lived, which is the same "a guess
 * rendered as a fact" failure the map already had. Re-probing every few hours
 * costs one trace request and makes a move self-correcting.
 */

export interface PrimaryLocation {
	colo: string | null;
	country: string | null;
}

/** A known location is good for this long before the next call re-probes. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** A FAILED probe is cached far more briefly - long enough that a burst of
 * admin requests does not each pay the 1.5s timeout (local dev answers
 * nothing at all), short enough that a transient network failure heals. */
const FAILURE_TTL_MS = 60 * 1000;

let cached: { at: number; ttl: number; value: PrimaryLocation } | null = null;
/** Concurrent callers share one probe instead of each opening a request. */
let inFlight: Promise<PrimaryLocation> | null = null;

async function probe(): Promise<PrimaryLocation> {
	try {
		const response = await fetch('https://cloudflare.com/cdn-cgi/trace', {
			signal: AbortSignal.timeout(1500),
		});
		const text = await response.text();
		return {
			colo: text.match(/^colo=([A-Z0-9]{3})$/m)?.[1] ?? null,
			country: text.match(/^loc=([A-Z]{2})$/m)?.[1] ?? null,
		};
	} catch {
		return { colo: null, country: null };
	}
}

export function primaryLocation(): Promise<PrimaryLocation> {
	if (cached && Date.now() - cached.at < cached.ttl) return Promise.resolve(cached.value);

	inFlight ??= probe().then((location) => {
		cached = {
			at: Date.now(),
			ttl: location.colo || location.country ? CACHE_TTL_MS : FAILURE_TTL_MS,
			value: location,
		};
		inFlight = null;
		return location;
	});
	return inFlight;
}
