# DB Agent — `@cloudflarebase/db` (Cloudflarebase's second primitive)

> **Shipped 2026-07-29** — all four phases landed and the full suite is green
> (105 tests incl. db REST/live-query/guard/demo/OpenAPI/UI coverage).
> **2026-07-30** — the first follow-up narrowed the "Non-goals v1" list:
> rules-lite (permission keys checked against JWT `permissions` claims, and
> declarative document validators on public writes), count/sum/avg aggregates,
> NDJSON export/import, and per-collection 30-day point-in-time restore with
> D1-style restore points all shipped as `@cloudflarebase/db` 0.2.0. The
> non-goals below are the v1 snapshot.
>
> Deviations from this plan, for future readers:
>
> - Manifests are **single-sourced** from `agents/<name>/cloudflarebase.agent.json`
>   (imported directly into `src/lib/agent-registry.ts`); the copied-JSON design
>   in the companion doc's §A.2 was superseded before implementation.
> - No separate `live.unit.test.ts`: the live engine lives inside
>   `collection.ts`; its behavior is pinned by `e2e/db-live.api.spec.ts` while
>   `query.unit.test.ts` pins compiler/matcher parity.
> - Document `PUT`/`PATCH` bodies are the raw data record; only create wraps as
>   `{ id?, data }`. The direct-agent e2e override is `DB_AGENT_URL` (auth owns
>   `AGENT_URL`). The dashboard create form defaults to read `public` / write
>   `owner`.
> - The db workers reuse the deployment-wide Sentry projects (same DSNs as root
>   `wrangler.jsonc`) instead of dedicated ones.
> - The copilot follow-up below is now decided: **console-orchestrated** tool
>   loop in the web worker over the service bindings, not a dedicated agent.

## Context

Cloudflarebase is an open-source Firebase alternative on Cloudflare; auth is the only primitive today. This adds the **db agent**: a Firestore-style document database with full live queries (onSnapshot parity), per-collection access modes verified against auth-agent project JWTs, a thin client SDK — published as `@cloudflarebase/db`. It is deliberately "agent #2", the moment `docs/agent-contract.md` was written for, so the `cloudflarebase.agent.json` manifest is implemented end-to-end as part of this work and auth is refactored onto the same rails first (zero behavior change).

Authoritative references: root `CLAUDE.md`, `agents/auth/CLAUDE.md`, `docs/agent-contract.md`. Full detailed design (schemas, protocol, file lists) in [db-agent-design.md](db-agent-design.md) — this file is the executable summary; the design doc is normative where this file abbreviates.

## Locked decisions (user-approved)

1. **Documents API** — Firestore-style collections of JSON documents; CRUD + queries (where/orderBy/limit/cursor) over REST.
2. **Full live queries** — clients subscribe to a _filtered query_ over WebSocket; server re-evaluates on writes, pushes per-subscriber `added`/`modified`/`removed` deltas.
3. **Access control** — per-collection read/write modes `public | auth | owner` against auth's project JWTs (JWKS); `owner` stamps/checks `owner` from `jwt.sub`.
4. **Thin client SDK** — `@cloudflarebase/db/client` subpath.
5. **Full manifest now** — both agents ship `cloudflarebase.agent.json`; CLI reads them; console guard/proxies/sidebar/fan-out/OpenAPI become registry-driven.
6. **Zod everywhere** — all DTOs, the query DSL, and the WS frame protocol are zod schemas end-to-end (agent `schemas.ts` → app mirrors with `.meta({id})` → OpenAPI/Scalar; client SDK reuses the package's own schemas).
7. **Collection-per-DO from day one** — two DO classes; plain sibling DO instances are the scaling mechanism (Facets rejected: child SQLite lives inside the parent DO — isolation, not scale; doc-per-DO rejected: queries need co-located rows).

## Architecture

| Class          | SDK                                                      | Instance name              | Owns                                                                                                                                              |
| -------------- | -------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DbAgent`      | Agents SDK `Agent<Env, DbAgentState>`                    | `<projectId>`              | collection registry (names, modes, reported counts), dashboard state sync (`rev` counter), project config, admin surface, demo TTL, erase fan-out |
| `DbCollection` | **plain `DurableObject`**, raw WebSocket Hibernation API | `<projectId>:<collection>` | documents table, query engine, live-query engine, cached config (pushed from parent), JWT verification, per-collection demo caps                  |

`DbCollection` is deliberately not an SDK Agent: SDK protocol frames (`cf_agent_state`) would leak operator data onto anonymous subscriber sockets, it needs no state sync/schedules, and raw `acceptWebSocket`/`serializeAttachment`/tags give exact subscription-survival control. `DbAgent` stays on the SDK because the dashboard consumes it with `AgentClient` exactly like auth.

**Routing (one public namespace, hot path = one hop):** worker entrypoint routes `/agents/db-agent/<pid>/collections/<c>/**` directly to the `DbCollection` stub (CRUD, `/query`, `/subscribe` WS); everything else via `routeAgentRequest` → `DbAgent` (`/config` public, `/overview`, `/admin/*`, root state-sync WS). `GET /health` and `DELETE /internal/projects/:id` on the worker itself (service-binding-only: no public route). No `cors: true`; both DOs use auth's exact CORS policy.

**Ceilings (documented honestly):** per collection 10 GB / ~1k req/s / one thread / own hibernated subscriber pool; no DO read replicas — push-based live queries are the mitigation. Cross-collection batches/transactions are out of scope v1 (shard independence is the point).

**Naming/ports:** worker `db-agent` (`-local/-test/-preview`; production pinned `db-agent`), web service binding `DB_AGENT`, dataset `cloudflarebase_db_events` (+ env suffixes) on binding `DB_EVENTS`. Dev :8789, e2e :8798→db :8799 (auth 8788/8798, web 5173/8797).

## Key designs (normative detail in companion §§B.1–B.7)

- **SQLite schema (drizzle, one shared migration journal, both classes apply idempotently):** `collections` (parent registry: name PK, read/write access, reported docs count), `documents` (id PK, `data` JSON text, `owner`, timestamps; indexes on updatedAt/owner), `subscriptions` (connId+subId PK, canonical query JSON, ownerSub, tokenExp, lastMembership for windowed queries), `collection_meta` (single-row cached config). Queries via `json_extract`; no generated columns/field indexes in v1.
- **Query DSL (`DbQuery`, zod):** `where` ≤10 AND-only clauses (`== != < <= > >= in array-contains`), dotted FieldPath (regex-validated → SQL interpolation is injection-free; values always bound), `orderBy` ≤2 + id tiebreak, `limit` ≤200, opaque base64 cursor (REST only). One parsed Query drives BOTH the SQL compiler (snapshots/REST) and the JS matcher (live deltas) — parity is the invariant unit tests pin; Firestore `!=` semantics (excludes missing field); `array-contains` guarded with `json_type` check.
- **Live queries:** raw hibernation WS at `/collections/<c>/subscribe`; attachment holds only `{connId}` — all state in the `subscriptions` table (hibernation-proof). Frames (zod, shared with SDK): `subscribe{id,query,token?}`/`unsubscribe` in; `snapshot`/`change{added|modified|removed}`/`unsubscribed`/`error{code}` out. On write: predicate diff for unlimited queries; windowed (orderBy+limit) re-query + `lastMembership` diff for correct enter/leave (incl. displacement). Lazy `tokenExp` expiry; reconnect = fresh snapshot (no resume tokens v1); dashboard uses `AgentClient` state sync + operator `POST /admin/query` refetch on `rev` bump, never the public socket.
- **JWT (`jose` ^6):** verifies EdDSA/RS256/ES256, `iss cloudflarebase:<pid>` / `aud <pid>` (verified against better-auth's jwt plugin config). JWKS fallbacks: `env.AUTH_AGENT` Fetcher (our multi-worker deploy) → `env.AuthAgent` DO namespace (consumer single-worker) → fail-closed 503 for auth/owner modes (public still works). 1 h DO-storage cache, rate-limited kid-miss refetch. Both bindings optional in the bindings contract.
- **Registry consistency:** parent-row-then-push with lazy child pull (`getCollectionConfig({autoCreate})` heals partial failures; auto-create is parent-mediated, one extra hop only on first touch; hot path never does parent lookups). Counters: children keep exact local counts, report debounced ABSOLUTE counts via RPC (best-effort, self-healing). Erase: parent destroys every child (auth's deleteAll→deleteAlarm→deferred-abort verbatim) and wipes itself only after all succeed; registry survives failures so retries find the children (contract rule 6).
- **Demo caps:** 5 collections / 200 docs each / 8 KB docs / 5 subs per connection / TTL 720 h. Always-on: 128 KB docs, 10 subs/connection, limit ≤200, ≤200 collections.
- **Manifest:** `manifestVersion: 1`; adds `proxy {apiPrefix, agentBasePath}`, `entrypoint.assertEnvType`, `worker`, `perCollection` scope. **Single-sourced in the agent packages** (user decision, supersedes the copied-JSON design in the companion §A.2): the app imports `agents/<name>/cloudflarebase.agent.json` directly — static declarative data, so the no-cross-project-import rule's spirit holds, and the guard can never drift from what the package declares. All app machinery in ONE file `src/lib/agent-registry.ts` (zod schema + parsed registry + route matcher + nav builder); CLI keeps its own schema copy and reads manifests from `node_modules`. Route access defaults to operator — declared-public-by-exception, like today's guard.

## Phases (each lands green: `npm run check` / `lint` / per-package `tsc --noEmit` / `npm test`)

### Phase A — Manifest rails + auth refactor (zero behavior change)

Create `agents/auth/cloudflarebase.agent.json` (+ package `files`/`exports`; fix the duplicate `"typecheck"` key), `src/lib/agents/{manifest,registry,console-nav}.ts` + `manifests/auth.json`, `src/lib/server/agents.ts` (generic `assertProjectId`/`toNativeResponse`/`requireAgent`/`agentUrl`; `auth-agent.ts` becomes a thin shim), split `src/lib/openapi.ts` → `src/lib/openapi/{index,auth}.ts`. Rewrite `classifyAccess` + `applicationHandle` in `src/hooks.server.ts` as manifest-driven dispatch (unknown workers/undeclared routes → operator, fail-closed). `registry.ts` erase becomes a loop over the registry. Sidebar/overview driven by `console.pages` (testIds preserved). Control plane: `project_agent` table (groundwork; deletion deliberately does NOT read it). **Proof: full e2e suite green with zero spec edits.**

### Phase B — the `agents/db` package

Auth's package shape exactly (own lockfile, `files`: dist/template/NOTICE/manifest; never ship `worker-configuration.d.ts`/`env.d.ts`). Sources: `index.ts` (routing + Sentry wrappers for BOTH classes), `agent.ts`, `collection.ts`, pure `query.ts` + `live.ts` (unit-tested via `node --import tsx --test`), `jwt.ts`, `schemas.ts`, `db/schema.ts` + inlined `migrations.ts`, `bindings.ts` + `bindings.test-d.ts`, templates (fragment: fresh v1 with BOTH classes), manifest, CLAUDE.md/README. Wrangler 5-block env matrix per companion §B.9 (AUTH_AGENT service binding per env; LOCAL_ANALYTICS D1 in local/test; test env sets no DEMO_MODE, mirroring auth's reasoning). Verify: tsc, unit tests, migrations, `npm pack --dry-run`, manual :8789 CRUD/WS round trip incl. restart-resubscribe.

### Phase C — web integration

`DB_AGENT` in all five `wrangler.jsonc` blocks + `wrangler.e2e.jsonc` + `app.d.ts` + `cf-typegen`; `deploy:all` = auth → db → web; `local-dev.json`/`postinstall.json`/`playwright.config.ts` (third webServer :8799). Registry gains the `db` entry — guard/dispatch/fan-out/sidebar follow automatically. Proxies: `db/collections/[...path]` public passthrough (forwards `Authorization`; WS goes direct via `/agents/*` like auth), `db/overview` + `db/admin/[...path]` operator. Dashboard `db/` tab mirroring the auth tab architecture (Collections browser + query controls + JSON editor, Access modes, Integration snippets; AgentClient `agent:'db-agent'` dev host :8789; refetch on `rev`). `src/lib/agents.ts` db zod mirrors; `src/lib/openapi/db.ts` Database tag (WS documented via component schemas + tag description). Overview `product-db` card; Database leaves `comingSoon`.

### Phase D — SDK, CLI, e2e, CI, docs

- **SDK** `src/client.ts` (isomorphic, zero Workers imports, reuses package schemas): `createDbClient({baseUrl, getToken})` → `collection(...)` CRUD/`query`/`subscribe` with local re-sort via the shared comparator + exponential-backoff resubscribe.
- **CLI**: `cli/src/lib/manifest.ts` (schema copy, `readManifest`, refuses unknown manifestVersion); registry shrinks to `{packageName, description}` — export lines DERIVED from the manifest; `entrypoint.ts` second-agent fix: existing cloudflarebase default → prepend CLASS-ONLY re-export (routeAgentRequest resolves any DO binding by name); non-cloudflarebase default keeps the UserError. Fragment merge already handles two classes (verify via packed-tarball double-add).
- **e2e** (self-seeding on `DB_PROJECT='e2e-db'`/`SCRATCH_PROJECT`; SEED_PROJECT counts untouched): `db.api` (three modes, Bearer flow, owner isolation, caps, cursor), `db-live.api` (WS through built worker AND direct :8799; snapshot/deltas/window displacement/auth errors), `db-agent-direct.api`, extend `console-guard` (+db 401s), `demo-project` (+db demo flow + caps), `db.ui`, extend `openapi` + `dashboard.ui`.
- **CI**: `db-agent-deploy-{prod,preview}.yaml` (GitHub environments, path filters), release.yaml `db-v*` arm (npm Trusted Publisher setup is a manual one-time op), quality.yaml db typecheck + unit tests.
- **Docs**: `agents/db/CLAUDE.md` (topology, ceilings, hibernation design, JWKS fallbacks, caps), root CLAUDE.md (layout row, commands, manifest + collection-per-DO decisions, e2e, gotchas incl. deploy order), auth CLAUDE.md delta, flip `docs/agent-contract.md` banner to implemented + record deltas, `agents/db/README.md`.

## Non-goals v1

No cross-collection batches/transactions/joins; no field indexes/generated columns; cross-type comparisons unspecified; no `newIndex`/`oldIndex` in frames; no resume tokens (fresh-snapshot reconnects); no db analytics-read surface; no AI chat on the db agent (see follow-up below — the copilot refactor is deliberately sequenced AFTER db lands, not designed away); no fleet-page db integration; no outbound email; no per-project agent enable/disable UI; no document-level rules or `data` validation; no `${prefix}` templating; fragment stays authored (not manifest-generated).

## Follow-up immediately after v1: the agentic copilot refactor

The copilot must become a **fully agentic backend copilot**, not auth-grounded chat — likely a master agent that orchestrates the auth agent, db agent, and future primitives (tool-calling over their admin surfaces), strategy to be designed as its own piece of work once DB is nailed. This plan deliberately keeps today's chat untouched and lays the groundwork: the manifest registry gives a future master agent machine-readable discovery of every agent's routes, permissions, and admin surface, and `DbAgent`'s operator HTTP + RPC surface (`/admin/query`, collection config, document edit) is exactly the tool set that copilot will drive. Nothing in v1 may couple the copilot pane harder to auth than it already is.

## Open risks

1. SQL-vs-JS matcher parity (mitigated: one parsed Query, matcher unit fixtures + SQL snapshot tests, e2e live spec; cross-type behavior documented unspecified).
2. Windowed re-query cost on hot collections (bounded by caps + sharding; incremental membership update possible later, no protocol change).
3. Parent→child config drift on failed push (retry-once + `configVersion`; seconds-level staleness accepted).
4. Two socket stacks (SDK for DbAgent, raw for DbCollection) — accepted for isolation.
5. `jose` new runtime dep (pinned caret).
6. Erase fan-out worst case ~200 sequential RPCs (chunk with allSettled if needed).
7. Sentry DSNs + npm Trusted Publisher for the new package are manual one-time ops (safe defaults until done).

## Verification roll-up

A: root check/lint + auth tsc + `npm test` with zero spec edits + dev walkthrough. B: db tsc/unit/migrations/build/pack + manual :8789 CRUD/WS/restart. C: check/lint/cf-typegen/`npm test` + three-process dev, Database tab end-to-end, erase fan-out (no 207). D: everything + CLI double-add on packed tarballs + demo-flow walkthrough.
