# DB Agent Worker

Two Durable Object classes per Cloudflarebase project: `DbAgent` (coordinator, instance name = project id) and `DbCollection` (one instance per collection, named `<projectId>:<collectionName>`). Firestore-style JSON documents with full live queries. See the repository `CLAUDE.md` for the overall system and `docs/db-agent-plan.md` + `docs/db-agent-design.md` for the approved design this implements.

## Topology and ceilings

Collection-per-DO is the scaling architecture: each collection gets its own 10 GB SQLite, ~1k req/s single thread, and hibernated subscriber pool. Durable Objects have no read replicas - push-based live queries are the read-scale mitigation. Cross-collection batches/transactions are deliberately unsupported (shard independence). Facets and doc-per-DO were evaluated and rejected (see the design doc).

`DbCollection` is a **plain DurableObject on the raw WebSocket Hibernation API**, not an Agents SDK Agent, so the public subscriber socket never carries SDK protocol frames (state sync would leak operator data to anonymous clients). `DbAgent` stays on the Agents SDK because the dashboard consumes it with `AgentClient` state sync exactly like the auth agent.

## Key files

- `src/index.ts`: entrypoint. Hot path `/agents/db-agent/<pid>/collections/<c>/**` goes STRAIGHT to the DbCollection stub (one hop, includes the `/subscribe` upgrade); everything else via `routeAgentRequest` to DbAgent; `/health` and service-binding-only `DELETE /internal/projects/:id` on the worker itself. Sentry wrappers on both classes.
- `src/agent.ts`: `DbAgent` - collection registry (the `collections` table), admin routes, state sync (`rev` counter drives dashboard refetches), demo TTL, erase fan-out.
- `src/collection.ts`: `DbCollection` - documents, query execution, the live-query engine, cached config, JWT gate, per-collection demo caps.
- `src/query.ts`: PURE module - one parsed Query drives the SQL compiler (snapshots/REST), the JS matcher (live deltas), and the order comparator (shared with the client SDK). Their parity is the invariant `src/query.unit.test.ts` pins.
- `src/jwt.ts`: project-JWT verification via `jose`; JWKS from the `AUTH_AGENT` service binding (multi-worker) or the `AuthAgent` DO namespace (single-worker consumer installs), cached 1 h in DO storage, kid-miss refetch rate-limited to 1/min. Neither binding -> token-gated collections 503, public ones unaffected.
- `src/schemas.ts`: every boundary schema - query DSL, CRUD bodies, WS frames, config, JWKS/JWT claims. App mirrors live in the dashboard's `src/lib/agents.ts`; the client SDK imports these directly (same package, so client and server cannot drift).
- `src/db/schema.ts` + `src/migrations.ts`: ONE drizzle pipeline for both classes; each applies the same inlined migrations idempotently and unused tables stay empty.

## The live-query engine

- Subscribe socket accepted with `ctx.acceptWebSocket(server, [connId])`; the attachment holds ONLY `{ connId }`. The `subscriptions` table is the durable state - hibernation-proof by construction.
- Frames (zod, in `schemas.ts`): `subscribe{id,query,token?}` / `unsubscribe` in; `snapshot` / `change{added|modified|removed}` / `unsubscribed` / `error{code}` out. One socket serves ONE collection; the SDK multiplexes subscriptions by id.
- On every write: unlimited queries get a predicate diff over old/new; windowed queries (orderBy+limit) re-run the compiled query and diff ids against `lastMembership`, which is what gets displacement right (insert pushes a doc out -> `removed`; delete pulls one in -> `added`).
- Token expiry is lazy (an integer compare per subscription per write); expired subscriptions get `error token-expired` and are dropped.
- Reconnects are fresh snapshots - no resume tokens in v1. Dead connections are pruned when `getWebSockets(connId)` comes back empty.

## Registry consistency (parent <-> children)

Row first, then push: `PUT /admin/collections/:name` upserts the parent row, then RPCs `configure()` to the child. A child with no cached config pulls once via `getCollectionConfig({ autoCreate: true })` - the healing path, and how first-write auto-creation stays parent-mediated. Config carries a monotonic `configVersion` so a stale push cannot regress a child. The hot data path NEVER consults the parent. Counters: children report debounced ABSOLUTE counts (self-healing, best-effort). Erase: children destroyed FIRST, registry kept until every child confirms, so a failed fan-out can be retried by id - nothing may orphan a DO holding user data.

## Demo caps

`demo-<20hex>` + `DEMO_MODE=true` (both halves): 5 collections, 200 docs/collection, 8 KB docs, 5 subscriptions/connection, TTL erase after `DEMO_TTL_HOURS` (idempotent schedule, re-checked before destroy). Always-on: 128 KB docs, 10 subscriptions/connection, query limit <= 200, 200 collections/project.

## Publishing as `@cloudflarebase/db`

Same regime as auth: `files` ships `dist`, `template`, `NOTICE`, `cloudflarebase.agent.json` only; never ship `worker-configuration.d.ts` (would clobber the consumer's global `Env`) or `src/env.d.ts`. `AssertDbAgentEnv` + `bindings.test-d.ts` lock the binding contract (`tsc --noEmit` is the whole test suite for it). The fragment is a FRESH v1 declaring BOTH classes. The `./client` subpath is the browser/Node SDK and must stay free of Workers imports.

## Constraints and gotchas

- DO SQLite blocks `pragma_table_info()` and explicit `BEGIN`/`COMMIT` (`SQLITE_AUTH`); migrations run through drizzle with no transactions.
- Raw SQL in `collection.ts` is assembled ONLY from `compileQuery` output: field paths are regex-validated (injection-free interpolation), values always bound.
- `DurableObjectNamespace<any>` blows up tsc's instantiation depth when you call `.get()` on it - cast to the parameterless `DurableObjectNamespace` first (see `jwt.ts`).
- Run Wrangler commands from `agents/db`; `--env local` dev port is 8789, `--env test` (Playwright) is 8799.
- The entrypoint may only export handlers and DO classes; a value export fails at boot with `Incorrect type for map entry`.
- `npm run migrations` after schema edits; never hand-edit `src/migrations.ts` or `drizzle/`.
- The deploy order is auth -> db -> web: this worker's `AUTH_AGENT` service binding needs the auth worker to exist.

## Development and tests

`npm run dev` starts `wrangler dev --env local` on :8789 (state shared in `../../.wrangler/state/`). `npm run test:unit` runs the query-engine parity tests under node:test/tsx. Playwright starts `db-agent-test` on :8799 with persistence in `../../.wrangler/test-state/db-agent`.
