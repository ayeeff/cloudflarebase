# DB Scale Plan — SQL tables, read replicas, unbounded realtime

> **Drafted 2026-08-04 — awaiting approval.** Extends the shipped
> [db-agent-plan.md](db-agent-plan.md) / [db-agent-design.md](db-agent-design.md).
> Once REP1/REP2 land, this supersedes their "no DO read replicas" ceilings; until
> then `agents/db/CLAUDE.md` remains authoritative for what exists. A detailed
> design doc (the db-agent-design.md equivalent) is written per phase before
> implementation; this file is the executable summary.

## Context

The db agent today is collection-per-DO: each collection is one `DbCollection`
Durable Object — 10 GB SQLite, ~1k req/s, one thread, one hibernated subscriber
pool capped at ~32k sockets. This plan removes the read and realtime ceilings
and adds a second data model, making Cloudflarebase the only product that is
**a Firestore alternative and a Supabase alternative at once**: documents AND
SQL tables, each collection/table its own isolated primary with read replicas
in every region and live queries on both models, out of the box.

## Platform facts (verified 2026-08-04 — re-verify at each phase start)

- **No public DO read replicas.** D1's global read replication is built
  internally on replica Durable Objects with log shipping + session bookmarks;
  that machinery is not exposed. We re-implement the same published model in
  userland — and keep the transport swappable in case it ever ships natively.
- **Placement is per-region, not per-colo.** `locationHint` supports 11 values
  (`wnam enam sam weur eeur apac apac-ne apac-se oc afr me`), is best-effort,
  and is respected only on the first `get()`. `sam`/`afr` spawn in nearby
  supported regions. D1 replicates to six regions; we can cover more.
- **Per-DO ceilings unchanged:** 10 GB SQLite, ~1k req/s soft limit, single
  thread, ~32k hibernatable WebSocket connections per instance.
- **Outgoing WebSockets do not hibernate** and keep a DO awake (up to 15 min
  per connection). Server-side accepted sockets hibernate. This shapes the
  replica tailing design below.

## Locked decisions

1. **Both engines, one package.** SQL tables are a third DO class `DbTable` in
   `@cloudflarebase/db`, not a separate agent. Deliberate deviation from
   one-primitive-one-agent: tables share the replication substrate, JWT gate,
   rules-lite, PITR/export machinery, and the Database dashboard section — one
   product, two models.
2. **Table-per-DO**, exactly like collection-per-DO. Every SQL query is
   single-table by construction — the constraint that makes live SQL queries
   tractable. No cross-shard joins/transactions (same v1 stance as
   cross-collection).
3. **Replication = D1's published model, deliberately**: row-image change log
   - LSN at the primary, full-copy replicas per region, session bookmarks,
     sequential consistency, writes always to the primary. "Same consistency
     model as D1, more regions" — and D1-complement positioning everywhere: D1
     is your shared relational database (we use it for our own control plane);
     `DbTable` is realtime-first, per-tenant, isolated SQL.
4. **Replicas ARE the fan-out layer.** No separate socket-shard class:
   subscribers land on their region's replica, which evaluates their live
   queries locally; under socket pressure a region spawns sibling replicas.
   The ~32k socket cap becomes per-replica, i.e. irrelevant.
5. **Story-order sequencing**: `DbTable` on the existing single-DO engine
   ships first (visible launch: "Supabase tables with Firestore realtime" —
   live queries need no replicas), then the replication substrate, then the
   realtime scale-out as a second launch moment with the replica map.
6. **Honest ceilings stay honest**: single-primary writes (~1k req/s per
   shard) and 10 GB unique data per shard remain and are documented plainly.
   The log/LSN design leaves room for hash-partitioned primaries post-v2; not
   promised anywhere.
7. **Marketing pages**: `/pricing` (self-hosted cost calculator, ships early,
   independent) and `/limits` (ceilings + worked scenarios, ships with the
   replication launch). Both `(marketing)` routes, public by group.
8. **The SQL layer is ORM-compatible (user decision).** Storage is the
   contract from T1 on: the physical table is named after the declared
   table with plain reserved system columns (`id`, `owner`, `created_at`,
   `updated_at`), so drizzle/prisma-generated SQL runs unmodified. The T2
   execution surface takes D1's request/response shape, making
   `drizzle-orm/d1`-style adapters thin shims; the column DSL remains the
   schema source of truth (ORM-authored DDL is refused, schema codegen
   ships instead). Details in db-table-design.md §10.

## Architecture

| Class          | Role                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| `DbAgent`      | coordinator, unchanged; registry gains `kind: 'collection' \| 'table'` and per-shard replication config |
| `DbCollection` | documents; gains primary role (log writer) and replica role (log applier + local live-query evaluation) |
| `DbTable`      | **new** — SQL tables; same primary/replica roles over the same substrate                                |

Instance naming: primaries stay `<pid>:<name>` (per class namespace); replicas
add a reserved suffix `…:r:<region>[:<n>]` (delimiter reserved against user
shard names — design-doc detail). A project with 3 collections and 2 tables is
1 `DbAgent` + 5 primaries + replicas where traffic exists.

### Replication substrate (engine-agnostic, shared by both classes)

- **Change log at the primary**: every committed write appends a row-image op
  `(lsn autoincrement, shard, id, image | tombstone)` in the same SQLite
  write. Row images, not statements — deterministic apply, one substrate for
  both engines. Retention is bounded (replicas behind the horizon
  re-bootstrap).
- **Replica lifecycle**: created lazily with `locationHint` on first read from
  a region. Boot = snapshot bootstrap (the existing export machinery) + LSN
  watermark. Active = tail socket to the primary (primary side is server-side,
  so hibernatable; the replica stays warm only while it has traffic). Idle =
  drop the socket; catch up on wake via `pullSince(lsn)` RPC.
- **Sessions**: the SDK carries a bookmark (last-seen LSN). A replica serves a
  read only once `applied_lsn >= bookmark` — brief wait, then proxy to the
  primary. Writes go to the primary and return the new LSN. Read-your-writes
  - monotonic reads (sequential consistency).
- **Routing**: the worker entrypoint maps `request.cf` → region; reads and
  `/subscribe` go to the region replica when replication is on, writes and all
  `/admin/*` to the primary. No client-side routing.
- **Config per shard**: `replication: 'off' | 'auto'` (auto = materialize
  replicas only where traffic exists — unlike D1 we pay replica storage).
  Auto is the default for every shard, demo projects included — the demo IS
  the pitch; `off` is the explicit single-region opt-out (Access tab / table
  designer / admin API).
- **Transport is a module.** If Cloudflare ships native DO replication, the
  log-shipping transport is replaced; sessions, routing, and live-query layers
  survive unchanged.

### Unbounded realtime

Subscribers connect to their region's replica, which holds their hibernated
sockets and runs the live-query engine locally — `query.ts` is already a pure
module, and the `subscriptions` table moves to whichever instance holds the
socket. At ~25k sockets a region spawns a sibling (`r:weur:2`), another full
copy. Capacity: 11 regions × N siblings × ~25k sockets ⇒ millions of
concurrent subscribers; the primary's per-write cost becomes O(replicas) — it
streams one log to tens of replicas instead of matching queries for every
client on one thread. Reconnect keeps v1 semantics (fresh snapshot); LSN
resume is a later protocol-compatible upgrade since replicas hold the log tail.

### `DbTable`

- **Schema**: typed column DSL via `PUT /admin/tables/:name` (name/type/
  nullable/default/unique + secondary indexes) applied as real SQLite DDL.
  Additive migrations only (ADD COLUMN, CREATE INDEX); no user DDL strings.
- **Three API tiers**: (1) typed CRUD + the same `where/orderBy/limit` DSL for
  public clients — the live-query surface; (2) a **D1-shaped SQL endpoint**
  (single-table; SELECT vs DML classified, DML `RETURNING`-captured so live
  queries and the change log fire; drivable by drizzle/prisma via thin
  adapters) — SELECT tier executes **only on replicas** once REP1 lands, so
  arbitrary SQL reads scale horizontally by construction; (3) operator SQL
  console in the dashboard (writes → primary).
- **RLS without a policy language**: access modes `public|auth|owner`; `owner`
  adds an implicit indexed `_owner` column auto-scoped on public reads/writes;
  `readPermission`/`writePermission` reuse `rules.ts` unchanged; column types
  - checks replace document validators.
- **Live SQL queries**: single-table ⇒ the existing algorithm generalizes
  (predicate diff on row images; windowed re-run + membership diff).
  `query.ts` splits into a shared core + two compilers under the same
  parity-test regime.
- A new DO class means a new migration tag in consumer wrangler configs — the
  CLI fragment-merge already appends under the next free tag; T1 exercises it.

### Ceilings after (the `/limits` page content)

| Dimension   | Today                     | After                                              |
| ----------- | ------------------------- | -------------------------------------------------- |
| Reads       | ~1k req/s per shard       | ~1k req/s × replica count                          |
| Realtime    | ~32k sockets, one matcher | ~25k sockets × replica count, matching distributed |
| Storage     | 10 GB per shard           | 10 GB unique per shard (replicas copy it — billed) |
| Writes      | ~1k req/s single primary  | **unchanged** — the honest remaining ceiling       |
| Consistency | single object, strong     | sequential + read-your-writes via bookmarks        |

"Unlimited users" means unlimited readers and subscribers; write throughput
scales by adding shards, not within one.

## Marketing pages

- **`/pricing`** — frame: "Our price is $0. This calculator estimates your
  Cloudflare bill." Preset chips (_Side project / Growing startup / 1M-user
  app_) fill 4–5 sliders (MAU, GB stored, writes/month, concurrent realtime,
  replica regions); output is one monthly number + a cost-breakdown bar +
  a same-workload-on-Firebase comparison line. Pricing constants live in one
  module with source URLs and an as-of date — fetched from current Cloudflare
  pricing docs at build time, reviewed on deploy, never a live API. Pure
  client-side.
- **`/limits`** — the scaling model as a diagram first, the numbers table,
  then worked scenario cards ("1M concurrent subscribers on one collection",
  "chat app with 10M users", "where you'll actually hit a wall" — with the
  sharding answer), then published Firestore/Supabase limits vs ours, sourced
  and linked. Honest limits are the credibility asset; ships with REP2 so the
  headline scenarios describe shipped behavior.
- Implementation notes: visual work gets a variant picker before rollout; the
  breakdown chart goes through the dataviz pass; e2e is marketing smoke specs
  only (public by group, no guard changes).

## The agentic backend thread (cross-cutting)

The copilot's endgame ([db-agent-plan.md](db-agent-plan.md) §Follow-up) is a
master agent that knows and operates the whole backend over the primitives'
admin surfaces. That refactor stays its own workstream — but this plan is
sequenced to feed it, and each phase ships its new surface as copilot tools,
not just UI:

- **T1**: table schemas are declared, not guessed — the copilot reads the
  registry (`kind` + column DSL) and gains schema-grounded tools; the tables
  admin surface joins `/admin/query` in the tool set.
- **REP1**: lag/health RPCs become tools (operational questions, not just data
  questions). The change log is an ordered per-project event stream — the
  substrate for standing queries and trigger-style automation later.
- **T2**: SELECT-only raw SQL on replicas is the copilot's ideal read tool —
  expressive, parser-gated, and blast-radius-isolated from primaries by
  construction (a runaway generated query can never block writes).
- **Write-capable tools wait for scoped authority**: the copilot gets a
  project JWT carrying rules-lite permission keys (the 403 machinery already
  exists), never an operator bypass.
- The manifest registry remains the discovery layer, and the same
  registry-driven tool surface is the natural shape for a per-project **MCP
  server** (external agents managing a Cloudflarebase backend) — post-T3,
  noted here so nothing in this plan precludes it.

## Phases (each lands green: `npm run check` / `lint` / per-package `tsc --noEmit` / unit / `npm test`)

### T1 — `DbTable` on the existing engine (launch #1)

No replication. `DbTable` class + schema DSL + typed CRUD/query + access modes
with `_owner` + live queries via the generalized engine; registry `kind`;
Tables dashboard UI (schema designer, data grid, Access sentence); OpenAPI +
`src/lib/agents.ts` mirrors; SDK `db.table(...)`; CLI fragment gains the class
(migration-tag append verified on packed tarballs); e2e mirroring the
collection specs (modes, owner isolation, live deltas, demo caps).

### M1 — `/pricing` calculator (independent, any time from now)

`(marketing)/pricing` as described; replica-regions slider may land marked
"coming" before REP2.

### REP1 — replication substrate (feature-flagged per shard)

Change log + LSN in both classes, snapshot bootstrap, `pullSince`, replica
role, region routing in the worker entrypoint, SDK session bookmarks,
lag/health RPC, replica map panel in the dashboard. Local dev/e2e simulate
regions by instance name (one colo locally) — routing logic fully testable.

### REP2 — realtime scale-out (launch #2, with M2)

Subscribe path lands on replicas; sibling spawn on socket pressure; primary →
replica log streaming; the replica-map demo. **M2 — `/limits`** ships with it.

### T2 — SQL depth

The D1-shaped SQL endpoint (single-table SELECT + DML with `RETURNING`
capture, statement classification, `batch`), the `@cloudflarebase/db/drizzle`
adapter and schema codegen from declared columns, SELECT routing to replicas,
table aggregates, LSN resume tokens if demand warrants. Prisma driver
adapter follows.

### T3 — parity + default-on

~~Replication `auto` by default~~ (shipped early, after T2: auto for every
shard including demos, with the dashboard Replication globe tab and per-shard
opt-out). ~~PITR/export/import parity for tables~~ (shipped 2026-08-05:
public `/tables/:name/export`, the six admin actions generalized over one
kind adapter, the shared `pitr.ts` restore sequence, SDK `exportRows`, and
the tables workspace export/import/rollback UI over the shared dialog).
~~Docs~~ (CLAUDE.mds + README updated with it). Remaining: landing-page
comparison table (variant picker first).

## Non-goals

No cross-shard joins/batches/transactions (table groups — co-locating small
tables in one DO for real joins — is a possible later opt-in, not planned);
no partitioned primaries (designed-for, not built); no per-colo placement;
no resume tokens at REP2 launch; no billing API behind `/pricing`; auth agent
scaling is out of scope.

## Open risks

1. **Replica storage is billed to the operator** (D1 absorbs it; we cannot).
   `auto` + traffic-driven materialization mitigates; pricing/limits docs must
   say it plainly.
2. `locationHint` best-effort + first-get-only ⇒ placement approximate;
   region granularity, not colo.
3. Bookmark waits add tail latency on read-after-write from cold regions;
   escape hatch = proxy that read to the primary (D1's own trade).
4. Cloudflare ships native DO replicas → transport module swap (planned for;
   the rest of the stack survives).
5. Log retention vs re-bootstrap correctness (horizon must force re-bootstrap,
   never silent gaps).
6. SELECT-only SQL validation robustness — parser allowlist, replicas-only
   blast radius, never the primary.
7. Reserved replica-name delimiter vs user shard names (design-doc detail).
8. The write ceiling stays; all copy must say unlimited _readers/subscribers_.

## Sources (as of 2026-08-04)

- https://blog.cloudflare.com/d1-read-replication-beta/
- https://developers.cloudflare.com/d1/best-practices/read-replication/
- https://developers.cloudflare.com/durable-objects/platform/limits/
- https://developers.cloudflare.com/durable-objects/reference/data-location/
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
