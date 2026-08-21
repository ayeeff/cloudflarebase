import { aggregateRequestSchema, querySchema } from './schemas';
import type { AggregateRequest, DbDocument, Query } from './schemas';
import type { Typed } from './client';

/**
 * The ADMIN client - the credential a server holds, with a real API in front
 * of it.
 *
 * Distinct from `./client` in three ways that matter:
 *
 * - **It targets the CONSOLE, never an agent.** A `cfbs_` service key is
 *   verified in the console guard and travels to the agent over a service
 *   binding the console already authorized; the agent worker never sees the
 *   bearer, and a key does not work on `/agents/*` at all. So `url` here is the
 *   console origin, not an agent base.
 * - **It is admin-grade.** Every route it calls bypasses access modes,
 *   document validators, and permission keys - the Firestore-Admin-SDK
 *   contract. A malformed document written through this client is NOT caught by
 *   rules-lite. That is not a bug to report; it is what an operator surface is.
 * - **It is server-only**, enforced twice over (see `assertServerOnly`).
 *
 * It lives in this package rather than a standalone one because it wraps the
 * DB AGENT's admin routes: when the agent gains a route, the client for it
 * ships in the same version. The console is the transport, not the subject.
 *
 * Method names mirror `./client` wherever the operation is the same, so the
 * two read alike.
 */

export interface DbAdminOptions {
	/** The console origin - e.g. `https://cloudflarebase.com`. NOT an agent base.
	 * Falls back to `CLOUDFLAREBASE_URL` / `CFBASE_URL`. */
	url?: string;
	/** The project this key belongs to. Keys are scoped to ONE registry row,
	 * never to a root's branches: for data the branch IS the isolation boundary.
	 * Falls back to `CLOUDFLAREBASE_PROJECT` / `CFBASE_PROJECT`. */
	projectId?: string;
	/** A `cfbs_` service key. An operator session bearer also works, but a key
	 * is what belongs in an environment variable. Falls back to
	 * `CLOUDFLAREBASE_SERVICE_KEY` / `CFBASE_SERVICE_KEY`. */
	key?: string;
	/** Override the fetch implementation (tests, instrumented clients). */
	fetch?: typeof fetch;
	/** Explicit environment, for Workers - where secrets arrive on `env`, not
	 * on a global `process`. */
	env?: Record<string, string | undefined>;
}

/**
 * Config resolution, most-explicit-first - the CLI's rule, so the two behave
 * alike: an explicit option wins, then the passed `env`, then the ambient
 * process environment.
 *
 * `CLOUDFLAREBASE_*` is canonical (it is what `CLOUDFLAREBASE_DEPLOY_TOKEN`,
 * the sibling credential, already uses); the shorter `CFBASE_*` spellings are
 * accepted because they match the `cfbs_`/`cfbd_` token prefixes and people
 * write them.
 */
function resolve(
	options: DbAdminOptions,
	explicit: string | undefined,
	names: string[],
	label: string,
): string {
	if (explicit) return explicit;
	const ambient = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
		?.env;
	for (const name of names) {
		const value = options.env?.[name] ?? ambient?.[name];
		if (value) return value;
	}
	throw new Error(
		`@cloudflarebase/db/admin needs ${label}: pass it explicitly, or set ${names.join(' or ')}. ` +
			`Inside a Worker, secrets live on \`env\` rather than a global process - pass \`{ env }\`.`,
	);
}

export class DbAdminError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = 'DbAdminError';
	}
}

/**
 * A 404 from a route the DEPLOYED agent does not have yet is indistinguishable
 * from a 404 meaning "no such document" - and conflating them is
 * data-loss-shaped: a caller that reads "not found" and then writes overwrites
 * a record that exists.
 *
 * The agent's own misses answer `{ error: 'no such ...' }`. A 404 without that
 * shape came from routing, so it is reported as this instead of as an absent
 * record. The third time deploy ordering has bitten this codebase.
 */
export class DbAgentTooOldError extends Error {
	constructor(path: string) {
		super(
			`the db agent did not recognise ${path}. Deploy @cloudflarebase/db 0.6.0 or newer ` +
				`before calling this - an older agent answers a 404 that looks like a missing record.`,
		);
		this.name = 'DbAgentTooOldError';
	}
}

/**
 * Refuse to run in a browser, loudly and at construction.
 *
 * The console guard already refuses any service-key request carrying an
 * `Origin`, so a key in frontend code fails on the first call. This fails
 * EARLIER and says why, because "401 from every request" does not tell a
 * developer that they shipped their admin credential to a CDN. The package's
 * `browser` export condition additionally fails the BUILD, which is earlier
 * still - see package.json.
 */
function assertServerOnly(): void {
	// `document` on globalThis, not `window`: this package builds against the
	// Workers types, which declare no DOM - and `document` is the more accurate
	// test anyway, since a Worker has neither.
	if (typeof (globalThis as { document?: unknown }).document !== 'undefined') {
		throw new Error(
			'@cloudflarebase/db/admin is server-only: it carries a service key, which is admin-grade ' +
				'over your whole project. Never import it into browser code. Use @cloudflarebase/db/client ' +
				'with the signed-in user’s project JWT instead.',
		);
	}
}

export function createDbAdmin(options: DbAdminOptions = {}) {
	assertServerOnly();
	const url = resolve(options, options.url, ['CLOUDFLAREBASE_URL', 'CFBASE_URL'], 'a console URL');
	const projectId = resolve(
		options,
		options.projectId,
		['CLOUDFLAREBASE_PROJECT', 'CFBASE_PROJECT'],
		'a project id',
	);
	const key = resolve(
		options,
		options.key,
		['CLOUDFLAREBASE_SERVICE_KEY', 'CFBASE_SERVICE_KEY'],
		'a service key',
	);

	const base = `${url.replace(/\/$/, '')}/api/projects/${encodeURIComponent(projectId)}/db`;
	const doFetch = options.fetch ?? fetch;

	async function request<R>(method: string, path: string, body?: unknown): Promise<R> {
		const headers: Record<string, string> = { authorization: `Bearer ${key}` };
		if (body !== undefined) headers['content-type'] = 'application/json';

		const response = await doFetch(`${base}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});

		const payload = (await response.json().catch(() => null)) as (R & { error?: string }) | null;
		if (!response.ok) {
			// A routing 404 is not a missing record - see DbAgentTooOldError.
			if (response.status === 404 && !/^no such /i.test(payload?.error ?? '')) {
				throw new DbAgentTooOldError(path);
			}
			throw new DbAdminError(
				response.status,
				payload?.error ?? `request failed (${response.status})`,
			);
		}
		return payload as R;
	}

	/** Documents and rows share one handle: the operations are identical by
	 * construction, exactly as they are in `./client`. */
	function handle<T extends Record<string, unknown>>(
		kind: 'collections' | 'tables',
		item: 'documents' | 'rows',
		name: string,
	) {
		const shard = `/admin/${kind}/${encodeURIComponent(name)}`;
		const itemPath = (id: string) => `${shard}/${item}/${encodeURIComponent(id)}`;
		const queryKey = kind === 'tables' ? 'table' : 'collection';

		return {
			/** Read one by id. Throws `DbAdminError(404)` when absent - `/admin/query`
			 * cannot do this at all, since its clauses compile to JSON paths into the
			 * document body and `id` is a system column. */
			get: (id: string) => request<Typed<T>>('GET', itemPath(id)),

			/** Upsert by id. `ifAbsent` refuses a taken id with 409 instead of
			 * replacing, which is what an ADD flow wants. */
			put: (id: string, data: T, opts: { ifAbsent?: boolean } = {}) =>
				request<Typed<T>>('PUT', `${itemPath(id)}${opts.ifAbsent ? '?ifAbsent=1' : ''}`, { data }),

			/** Shallow merge. Never creates - `put` is the upsert. */
			patch: (id: string, partial: Partial<T>) =>
				request<Typed<T>>('PATCH', itemPath(id), { data: partial }),

			delete: (id: string) => request<{ deleted: true }>('DELETE', itemPath(id)),

			query: (query: Query = {}) =>
				request<{ docs: Typed<T>[]; nextCursor?: string }>('POST', '/admin/query', {
					[queryKey]: name,
					query: querySchema.parse(query),
				}),

			aggregate: async (aggregate: AggregateRequest) => {
				const { results } = await request<{ results: Record<string, number | null> }>(
					'POST',
					'/admin/aggregate',
					{ [queryKey]: name, aggregate: aggregateRequestSchema.parse(aggregate) },
				);
				return results;
			},

			count: async (where?: AggregateRequest['where']) => {
				const results = await request<{ results: Record<string, number | null> }>(
					'POST',
					'/admin/aggregate',
					{
						[queryKey]: name,
						aggregate: aggregateRequestSchema.parse({
							where,
							aggregates: { total: { op: 'count' } },
						}),
					},
				);
				return results.results.total ?? 0;
			},

			/** Replace this shard's configuration (access modes, rules, schema). */
			configure: (config: Record<string, unknown>) => request<unknown>('PUT', shard, config),

			/** Delete the whole collection or table. */
			drop: () => request<unknown>('DELETE', shard),
		};
	}

	return {
		collection<T extends Record<string, unknown> = Record<string, unknown>>(name: string) {
			return handle<T>('collections', 'documents', name);
		},

		table<T extends Record<string, unknown> = Record<string, unknown>>(name: string) {
			const rows = handle<T>('tables', 'rows', name);
			return {
				...rows,
				/**
				 * One gated SELECT/INSERT/UPDATE/DELETE over this table, or an atomic
				 * batch. The operator mirror takes NO project JWT, which is why a
				 * service key reaches it where the public SQL route refuses.
				 */
				sql: (sql: string, params: unknown[] = []) =>
					request<{ success: boolean; batch: unknown[] }>(
						'POST',
						`/admin/tables/${encodeURIComponent(name)}/sql`,
						{ sql, params },
					),
			};
		},

		/** Collection and table counts for the project. */
		overview: () => request<unknown>('GET', '/overview'),
	};
}

export type { DbDocument, Typed };
