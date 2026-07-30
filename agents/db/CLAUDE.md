# DB Agent Worker

Two Durable Object classes per Cloudflarebase project: `DbAgent` (coordinator, instance name = project id) and `DbCollection` (one instance per collection, named `<projectId>:<collectionName>`). Firestore-style JSON documents with full live queries. See the repository `CLAUDE.md` for the overall system and `docs/db-agent-plan.md` + `docs/db-agent-design.md` for the approved design this implements.

## Topology and ceilings

Collection-per-DO is the scaling architecture: each collection gets its own 10 GB SQLite, ~1k req/s single thread, and hibernated subscriber pool. Durable Objects have no read replicas - push-based live queries are the read-scale mitigation. Cross-collection batches/transactions are deliberately unsupported (shard independence). Facets and doc-per-DO were evaluated and rejected (see the design doc).

`DbCollection` is a **plain DurableObject on the raw WebSocket Hibernation API**, not an Agents SDK Agent, so the public subscriber socket never carries SDK protocol frames (state sync would leak operator data to anonymous clients). `DbAgent` stays on the Agents SDK because the dashboard consumes it with `AgentClient` state sync exactly like the auth agent.

## Key files

- `src/index.ts`: entrypoint. Hot path `/agents/db-agent/<pid>/collections/<c>/**` goes STRAIGHT to the DbCollection stub (one hop, includes the `/subscribe` upgrade); everything else via `routeAgentRequest` to DbAgent; `/health` and service-binding-only `DELETE /internal/projects/:id` on the worker itself. Sentry wrappers on both classes.
- `src/agent.ts`: `DbAgent` - collection registry (the `collections` table), admin routes, state sync (`rev` counter drives dashboard refetches), demo TTL, erase fan-out.
- `src/collection.ts`: `DbCollection` - documents, query execution, the live-query engine, cached config, JWT gate, per-collection demo caps.
- `src/query.ts`: PURE module - one parsed Query drives the SQL compiler (snapshots/REST), the JS matcher (live deltas), and the order comparator (shared with the client SDK). Their parity is the invariant `src/query.unit.test.ts` pins. Also compiles aggregates: `compileAggregate` (SQL) and `aggregateDocs` (JS parity twin).
- `src/rules.ts`: PURE module - rules-lite enforcement: `validateDocument` (the per-collection validator DSL) and `hasPermission` (JWT permission gate, `*` wildcard = the built-in admin role). Pinned by `src/rules.unit.test.ts`.
- `src/jwt.ts`: project-JWT verification via `jose`; JWKS from the `AUTH_AGENT` service binding (multi-worker) or the `AuthAgent` DO namespace (single-worker consumer installs), cached 1 h in DO storage, kid-miss refetch rate-limited to 1/min. Neither binding -> token-gated collections 503, public ones unaffected.
- `src/schemas.ts`: every boundary schema - query DSL, CRUD bodies, WS frames, config, JWKS/JWT claims. App mirrors live in the dashboard's `src/lib/agents.ts`; the client SDK imports these directly (same package, so client and server cannot drift).
- `src/db/schema.ts` + `src/migrations.ts`: ONE drizzle pipeline for both classes; each applies the same inlined migrations idempotently and unused tables stay empty.

## The live-query engine

- Subscribe socket accepted with `ctx.acceptWebSocket(server, [connId])`; the attachment holds ONLY `{ connId }`. The `subscriptions` table is the durable state - hibernation-proof by construction.
- Frames (zod, in `schemas.ts`): `subscribe{id,query,token?}` / `unsubscribe` in; `snapshot` / `change{added|modified|removed}` / `unsubscribed` / `error{code}` out. One socket serves ONE collection; the SDK multiplexes subscriptions by id.
- On every write: unlimited queries get a predicate diff over old/new; windowed queries (orderBy+limit) re-run the compiled query and diff ids against `lastMembership`, which is what gets displacement right (insert pushes a doc out -> `removed`; delete pulls one in -> `added`).
- Token expiry is lazy (an integer compare per subscription per write); expired subscriptions get `error token-expired` and are dropped.
- Reconnects are fresh snapshots - no resume tokens in v1. Dead connections are pruned when `getWebSockets(connId)` comes back empty.

## Rules-lite: permission gates and document validators

Collection config carries three optional extras beyond the access modes, all edited via `PUT /admin/collections/:name` (omitted field = unchanged, explicit null = clears - so a modes-only save can never clobber rules configured earlier):

- **`readPermission` / `writePermission`**: a permission key (auth agent grammar: `resource:action` or `*`) the verified JWT's `permissions` claim must carry. Only meaningful for auth/owner modes - public requests carry no token. A valid token lacking the key gets **403** (distinct from the tokenless 401); the subscribe path enforces `readPermission` identically. `*` in the claim (the built-in admin role) passes everything; requiring `*` means "admin tokens only".
- **`validator`**: declarative document rules over TOP-LEVEL fields only (dotted paths would make PATCH merge semantics ambiguous): `type`, `required`, `maxLength` (strings/arrays), `min`/`max` (numbers), `enum`, plus `additionalFields: reject`. Enforced on the PUBLIC write path only; PATCH validates the merged result. Operator surfaces (dashboard editor, admin import) bypass rules exactly like they bypass access modes - the Firestore Admin SDK model. Violations are 400 `document failed validation` with an `issues` array.

## Aggregates, export/import, point-in-time restore

- **`POST /collections/<c>/aggregate`** (read-gated, owner-scoped): count/sum/avg, 1-5 per request keyed by alias, over the same where clauses as a query. sum/avg consider only genuine JSON numbers (`json_type IN ('integer','real')` - booleans are 'true'/'false', so they're skipped, Firestore-style); sum of nothing is 0, avg of nothing null. `POST /admin/aggregate` (`{ collection, aggregate }`) is the operator mirror over child RPC.
- **`GET /collections/<c>/export`** (read-gated; owner mode exports only the caller's documents) streams NDJSON in id order via keyset pages - NOT a point-in-time snapshot (racing writes may or may not appear; each id at most once). `GET /admin/collections/:name/export` streams the same through the parent via chunked `exportChunk` RPC.
- **`POST /admin/collections/:name/import`** (operator-only): NDJSON body, max 1000 lines / 10 MB. Exported lines round-trip exactly - id, owner, and timestamps are preserved. Bad lines are reported with 1-based line numbers without sinking the batch; parent feeds children in 100-line RPC chunks (`IMPORT_RPC_CHUNK`), then reconciles the doc count immediately.
- **`POST /admin/collections/:name/restore`** (operator-only): PITR over DO SQLite bookmarks - `{ timestamp }` (parent enforces the 30-day window) or `{ bookmark }`. The child closes every subscriber socket (they reconnect and get fresh snapshots against the restored data, which the hibernation design makes safe by construction) and aborts a tick after answering; every success returns an `undoBookmark` that reverses it via another restore, ALSO persisted as a restore point. **Local development has no durable change log**: the child reports unsupported (matched by `UNSUPPORTED_PITR_PATTERN` - workerd phrases it "does not implement point-in-time recovery") and the parent answers 501; the dashboard learns this up front from `restore-points` and explains instead of arming the form. `db.api.spec.ts` pins all of it.
- **Restore points + D1-style resolution** (all operator-only, parent-side): the parent persists named PITR markers in its `restore_points` table - manual `POST /admin/collections/:name/checkpoint`, automatic `before import` and `before rollback` - listed by `GET /admin/collections/:name/restore-points` as `{ supported, points }` (support probed via the child's side-effect-free `currentBookmark()`; >30-day rows pruned on read; `MAX_RESTORE_POINTS` caps markers only, never restorability). `GET /admin/collections/:name/bookmark?at=<ISO>` mimics D1's restore flow: time in, closest available bookmark out, shown in the dialog before anything is committed. Deleting a collection drops its markers - a deliberate erase must stay erased.

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
- An RPC method whose RETURN contains `Record<string, unknown>` (any `DbDocument`) collapses to `never` on the typed stub - `unknown` fails the workers-types `Rpc.Serializable` transform. Results fed straight into `Response.json()` never notice; destructuring ones need the documented cast (see `adminExport` in `agent.ts`). Avoid `string | null` PARAMETERS on RPC methods for the same reason (use an optional string).
- A destroyed/restored instance schedules `ctx.abort()` a tick after replying; in PRODUCTION that abort can outrace the RPC reply across colos, surfacing as `Application called abort() to reset Durable Object` at the caller even though the operation COMPLETED. Local workerd always flushes the reply first, so tests never catch it. Every call site tolerates it (`isDurableObjectReset`): `destroyChild` verifies the wipe on abort-reset (zero docs = landed, else rethrow so the registry row survives for retry), `adminRestore` captures the undo point BEFORE the restore, and both agents' worker erase routes treat abort-reset as success.
- Run Wrangler commands from `agents/db`; `--env local` dev port is 8789, `--env test` (Playwright) is 8799.
- The entrypoint may only export handlers and DO classes; a value export fails at boot with `Incorrect type for map entry`.
- `npm run migrations` after schema edits; never hand-edit `src/migrations.ts` or `drizzle/`.
- The deploy order is auth -> db -> web: this worker's `AUTH_AGENT` service binding needs the auth worker to exist.

## Development and tests

`npm run dev` starts `wrangler dev --env local` on :8789 (state shared in `../../.wrangler/state/`). `npm run test:unit` runs the query-engine parity tests under node:test/tsx. Playwright starts `db-agent-test` on :8799 with persistence in `../../.wrangler/test-state/db-agent`.
