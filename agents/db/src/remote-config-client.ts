/**
 * The Remote Config client (RC3).
 *
 * Isomorphic and dependency-free, like `./client` - browsers, Node, and
 * Workers. It talks to ONE endpoint (`GET /remote-config`), which answers with
 * values already evaluated for this caller, so there is nothing to evaluate
 * here and no targeting rule ever reaches the device.
 *
 * Three things carry the design:
 *
 * 1. **Defaults are not optional sugar.** An app has to render before the
 *    network answers and has to keep working when the endpoint is unreachable.
 *    `get()` therefore never throws, never returns undefined, and falls back
 *    through the same order every time: fetched value, then default.
 * 2. **`fetch()` never rejects for a network reason.** It reports whether it
 *    refreshed and leaves the previous values in place otherwise. A config
 *    fetch that throws turns a flag into a crash on launch, which is the exact
 *    failure a kill switch exists to prevent.
 * 3. **`subscribe()` is revalidation, not a push.** The parameter table is
 *    closed to clients, so there is no socket to hang a subscription on - and
 *    a push could not carry values anyway, because evaluation depends on
 *    caller context the shard does not hold. What this does instead is cheap:
 *    an `If-None-Match` poll that costs a 304 whenever nothing changed, and
 *    fires the handler only when a value actually moves.
 */

export type RemoteConfigValue = string | number | boolean | null | object;

export interface RemoteConfigOptions {
	/**
	 * The agent base or the console proxy base - the same `baseUrl` the db
	 * client takes, e.g. `https://console.example.com/api/projects/p1/db`.
	 */
	baseUrl: string;
	/**
	 * What every `get()` falls back to. Ship the values your code was written
	 * against: this is what runs before the first fetch answers, and what keeps
	 * running if it never does.
	 */
	defaults?: Record<string, RemoteConfigValue>;
	/** Called per fetch; a signed-in user's project JWT enables role and
	 * permission targeting. Null (or omitted) fetches anonymously. */
	getToken?: () => Promise<string | null> | string | null;
	/**
	 * Stable per-install id for percentage rollouts, used when there is no
	 * token. Generate one once and persist it - a fresh id per launch puts the
	 * same user in a different bucket every time, which is what makes a
	 * gradual rollout look like a flickering flag.
	 */
	uid?: string;
	/** This build's version, for `appVersion` rules. */
	appVersion?: string;
	/** Injectable for tests and instrumented clients. */
	fetch?: typeof fetch;
}

export interface RemoteConfigFetchResult {
	/** False when the server answered 304 - the values are already current. */
	changed: boolean;
	/** True when the request itself failed; previous values are untouched. */
	failed: boolean;
}

/** Deep-equality over JSON values, which is all a config value can be. */
function sameValue(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function createRemoteConfig(options: RemoteConfigOptions) {
	const base = options.baseUrl.replace(/\/$/, '');
	const doFetch = options.fetch ?? fetch;
	const defaults = { ...(options.defaults ?? {}) };

	let values: Record<string, unknown> = {};
	let fetched = false;
	let etag: string | null = null;
	let lastFetchedAt: string | null = null;
	const listeners = new Set<(values: Record<string, unknown>) => void>();

	function snapshot(): Record<string, unknown> {
		return { ...defaults, ...values };
	}

	function announce(previous: Record<string, unknown>): boolean {
		const next = snapshot();
		const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
		let changed = false;
		for (const key of keys) {
			if (!sameValue(previous[key], next[key])) {
				changed = true;
				break;
			}
		}
		if (changed) for (const listener of listeners) listener(next);
		return changed;
	}

	async function fetchConfig(): Promise<RemoteConfigFetchResult> {
		const previous = snapshot();
		const query: string[] = [];
		const token = (await options.getToken?.()) ?? null;
		// A token identifies the caller, so the uid is only needed without one -
		// sending both would let the two disagree about who this is.
		if (!token && options.uid) query.push(`uid=${encodeURIComponent(options.uid)}`);
		if (options.appVersion) query.push(`appVersion=${encodeURIComponent(options.appVersion)}`);

		const headers: Record<string, string> = {};
		if (token) headers.authorization = `Bearer ${token}`;
		if (etag) headers['if-none-match'] = etag;

		let response: Response;
		try {
			response = await doFetch(
				`${base}/remote-config${query.length ? `?${query.join('&')}` : ''}`,
				{
					headers,
				},
			);
		} catch {
			// Unreachable is not an error to the caller: the app keeps the values
			// it has, or its defaults.
			return { changed: false, failed: true };
		}

		if (response.status === 304) return { changed: false, failed: false };
		if (!response.ok) return { changed: false, failed: true };

		const body = (await response.json().catch(() => null)) as {
			params?: Record<string, unknown>;
			fetchedAt?: string;
		} | null;
		if (!body || typeof body.params !== 'object' || body.params === null) {
			// A 200 we cannot read is a failure, not an empty config - treating it
			// as empty would silently reset every flag to its default.
			return { changed: false, failed: true };
		}

		values = body.params;
		fetched = true;
		etag = response.headers.get('etag');
		lastFetchedAt = body.fetchedAt ?? null;
		return { changed: announce(previous), failed: false };
	}

	return {
		/**
		 * Refresh from the server. Resolves either way - check `failed` if you
		 * care - so a launch path can `await config.fetch()` unguarded.
		 */
		fetch: fetchConfig,

		/**
		 * One value, typed by what you pass as the default.
		 *
		 * Never throws and never returns undefined: an unknown key falls back to
		 * the declared defaults, and a key absent from both returns whatever
		 * `fallback` says. Config is read on the hot path of rendering, and a
		 * throw there is worse than a stale value.
		 */
		get<T extends RemoteConfigValue>(key: string, fallback?: T): T {
			if (Object.hasOwn(values, key)) return values[key] as T;
			if (Object.hasOwn(defaults, key)) return defaults[key] as T;
			return fallback as T;
		},

		/** Everything, defaults merged under the fetched values. */
		getAll: snapshot,

		/** Whether a fetch has ever succeeded - useful for a "using defaults"
		 * indicator, and for deciding whether to block first paint. */
		get isFetched(): boolean {
			return fetched;
		},

		/** Server timestamp of the last successful fetch; null until then. */
		get fetchedAt(): string | null {
			return lastFetchedAt;
		},

		/**
		 * Watch for changes. Revalidates on an interval and calls the handler
		 * only when a value actually moved - an unchanged config costs a 304 and
		 * fires nothing.
		 *
		 * The default interval is deliberately not aggressive. Publishing already
		 * carries a propagation window at the edge, so polling faster than that
		 * buys nothing but requests.
		 */
		subscribe(
			handler: (values: Record<string, unknown>) => void,
			{ intervalMs = 60_000 }: { intervalMs?: number } = {},
		): () => void {
			listeners.add(handler);
			const timer = setInterval(() => void fetchConfig(), Math.max(5_000, intervalMs));
			// Node keeps the process alive for a pending timer; a config poll
			// should never be the reason a script does not exit.
			(timer as unknown as { unref?: () => void }).unref?.();
			return () => {
				listeners.delete(handler);
				clearInterval(timer);
			};
		},
	};
}

export type RemoteConfigClient = ReturnType<typeof createRemoteConfig>;
