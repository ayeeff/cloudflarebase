/**
 * Where does this Durable Object actually run? `/cdn-cgi/trace` answers with
 * the EXECUTING machine's colo (IATA) and country - the only self-location
 * signal a DO has, since `request.cf` always describes the caller's edge.
 * Best-effort with a short timeout and cached per isolate: this feeds the
 * dashboard's replication map, and an unknown location must never slow an
 * admin response down. Local dev simply reports nulls.
 */

export interface PrimaryLocation {
	colo: string | null;
	country: string | null;
}

let cached: Promise<PrimaryLocation> | null = null;

export function primaryLocation(): Promise<PrimaryLocation> {
	cached ??= (async () => {
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
	})();
	return cached;
}
