# Replication Design — the REP1 substrate (phases REP1/REP2 of db-scale-plan.md)

> **Drafted 2026-08-05 — the phase-REP1/REP2 design for [db-scale-plan.md](db-scale-plan.md).**
> Normative for implementation, same role db-table-design.md played for T1.
> REP1 ships the substrate (log, replicas, sessions, routing, observability)
> with REST reads on replicas; REP2 moves live queries onto them. The model is
> D1's published replication design re-implemented in userland: log shipping,
> session bookmarks, sequential consistency, single-primary writes.
>
> **REP1 core implemented 2026-08-05.** Deviations, for future readers:
>
> - **Imports replicate through the log**, they do not bump the epoch (§2 as
>   drafted): admin import funnels through the normal write path, so every
>   imported line is an ordinary `put` entry. Only PITR restores bump the
>   parent-owned epoch - the one path that rewrites data without the write
>   path.
> - `repBootstrap` takes the caller's identity and REGISTERS it before
>   returning (the live smoke caught a bootstrapped-but-unregistered replica
>   - an erase-fan-out orphan - when registration lived only in `repPull`).
> - Data+log atomicity rides DO write coalescing (log append in the same
>   task, no intervening I/O awaits) rather than `transactionSync` - risk #2's
>   fallback, chosen because drizzle's async API cannot run inside a sync
>   callback; verified against live workerd.
> - The dashboard replica-map panel and the copilot ops tool ship with the
>   REP2/M2 chunk; `/admin/replication/:name` (the data they consume) is live.
> - `/aggregate` routes to replicas for collections only (tables gain
>   aggregates in T2).
>
> **REP2 core implemented 2026-08-05.** Further deviations:
>
> - **Live delivery is RPC push, not a tail socket** (§3/§8 as drafted). An
>   outgoing socket dies when the replica hibernates - exactly when pushes
>   must still arrive. Instead the primary calls `repApply(entries, epoch)`
>   on every push-flagged replica after a write (waitUntil): RPC WAKES a
>   hibernated replica, which applies the entries, notifies its local
>   subscribers, and hibernates again. No sockets, no tokens, no keep-alive
>   fights. Replicas flip their primary's push flag on subscriber-count
>   transitions; a `{stop}` answer (no subscribers left) self-heals stale
>   flags; a gap or epoch mismatch triggers a healing pull - which ALSO
>   notifies subscribers, so pull-healed changes arrive as deltas too.
> - `repBootstrap` answers `{ ok: false }` for disabled shards instead of
>   throwing - stale routing hits it constantly right after a disable, and
>   an expected condition must not be Sentry noise.
> - **Sibling spawn is deferred** past REP2: one replica per region for now
>   (the naming, parsing, and routing already carry `:n`, so adding spawn is
>   additive). The per-shard realtime ceiling is therefore ~32k sockets ×
>   regions until then.

## 1. Shape

Replication is per shard (one collection or table), configured
`replication: 'off' | 'auto'`, default off in REP1 (T3 flips tables to auto).
The SAME DO classes host both roles; the instance name decides:

| Role    | Instance name                   | Holds                                                                 |
| ------- | ------------------------------- | --------------------------------------------------------------------- |
| primary | `<pid>:<name>`                  | authoritative data + the change log + the replica registry            |
| replica | `<pid>:<name>:r:<region>[:<n>]` | a full copy, applied from the log; serves reads (REP2: + subscriptions) |

`:` cannot appear in project or shard names, so the `:r:` suffix is
unambiguous. `<region>` is a Cloudflare location hint (`wnam enam sam weur
eeur apac apac-ne apac-se oc afr me`); `<n>` is the REP2 sibling index (REP1
always `1`). Replicas are created lazily by the first routed read from a
region - `namespace.get(id, { locationHint: region })`, best-effort placement
by design.

**Writes never touch replicas.** The worker routes them to the primary;
a replica that receives one anyway (stale routing cache) forwards it over
its own namespace binding to the primary stub - correctness never depends on
routing being right, only latency does.

## 2. The change log (primary side)

A `changelog` table in the shard's own SQLite, written in the SAME
`transactionSync` as the data mutation (explicit BEGIN is SQLITE_AUTH;
`ctx.storage.transactionSync` is the sanctioned atomicity):

```
changelog(
  lsn   INTEGER PRIMARY KEY AUTOINCREMENT,
  op    TEXT NOT NULL,        -- 'put' | 'del' | 'cfg'
  id    TEXT NOT NULL,        -- document/row id ('' for cfg)
  image TEXT,                 -- full DTO JSON for put (post-write, incl.
                              -- owner/timestamps), config JSON for cfg,
                              -- NULL for del (tombstone)
  ts    INTEGER NOT NULL
)
```

- **Row images, not statements**: apply is deterministic and engine-agnostic
  - one substrate replicates documents and typed rows. `put` upserts the
    image verbatim (ids, owners, timestamps preserved - the import machinery's
    fidelity rules); `del` deletes; `cfg` runs the child's normal `configure()`
    (which for tables plans and applies DDL - schema changes replicate in
    order with the data).
- **Off = zero overhead**: with `replication: 'off'` nothing is logged and
  the LSN never advances. Flipping to `auto` starts the log at the current
  state; replicas bootstrap from a snapshot, so no history is needed.
- **Retention is bounded**: `MAX_LOG_ROWS` (100k) pruned opportunistically on
  write. A replica behind the horizon gets `{ resync: true }` from
  `pullSince` and re-bootstraps - the horizon FORCES resync, it can never
  create a silent gap (risk #5 of the scale plan).
- Restores interact loudly: a PITR restore rewrites the whole table without
  passing the write path, so `restoreTo` on a replicated primary bumps an
  **epoch** (stored beside the log; part of every pull reply). A replica
  seeing a new epoch discards and re-bootstraps. Same for import.

## 3. The feed (replica side) - the swappable transport

Everything a replica consumes goes through ONE small interface, because the
whole transport is designed to be thrown away if the platform ever ships
native DO replication (scale-plan risk #4):

- `bootstrap()` → `{ config, epoch, lsn }` then `snapshotChunk(afterId)`
  pages (the export machinery's keyset pagination, ids/owners/timestamps
  preserved). Writes racing the snapshot are safe: the replica then applies
  the log from the snapshot's starting LSN, and put/del application is
  idempotent by image.
- `pullSince(lsn, replicaId)` → `{ resync: true, epoch }` |
  `{ entries: [...], lastLsn, epoch }` (bounded chunks, 500 entries). The
  primary records `replicaId → { region, appliedLsn, lastSeenAt }` in a
  `replicas` table DURABLY BEFORE serving data - the erase fan-out reads it,
  so no replica holding data can be unknown to its primary.
- REP2 adds the push stream: an internal tail socket (server side on the
  primary = hibernatable; the replica's outgoing side keeps only
  traffic-bearing replicas warm). REP1 is pull-only.

**REP1 freshness rule (pull-only)**: a replica serves a read if it pulled
within `MAX_LAG_MS` (3s - the dashboard's own polling cadence); otherwise it
pulls first. Combined with bookmarks this is sequential consistency with
bounded staleness - the honest v1, stated in docs as "replica reads may be
up to ~3s behind unless your session has seen newer data".

## 4. Sessions (read-your-writes)

D1's bookmark contract, LSN-shaped:

- Every primary write response carries `cfb-lsn: <n>`.
- The SDK keeps the highest LSN seen per shard handle and sends
  `cfb-min-lsn` on reads (headers pass through the console proxy untouched).
- A replica read with `min-lsn > appliedLsn` pulls immediately; if it still
  cannot catch up (primary unreachable), it FORWARDS the read to the primary
  rather than serving stale data. Monotonic reads + read-your-writes, never
  a hard failure introduced by replication.
- Operators and the dashboard always read the primary (admin surfaces are
  primary-only by routing), so console counts stay exact.

## 5. Routing (worker entrypoint)

- **Region key**: `request.cf.continent` mapped to a hint (`NA→enam/wnam by
cf.region longitude bucket, SA→sam, EU→weur/eeur likewise, AS→apac,
OC→oc, AF→afr`, Middle-East country list → `me`), one static documented
  table in `region.ts`. Wrong-but-close is acceptable; hints are best-effort
  anyway.
- **Per-shard flag cache**: the worker keeps an isolate-local
  `Map<shardKey, { auto: boolean, at }>` (60s TTL) filled by one parent RPC
  (`getShardRouting`) on miss. Reads route to `…:r:<region>:1` only when the
  flag is `auto`; everything else keeps today's one-hop primary path - a
  non-replicated shard NEVER pays an extra hop or an extra DO request.
  Stale-cache misroutes are correct (replica forwards; primary always
  serves).
- What routes to replicas: GET document/row, `POST /query`,
  `POST /aggregate`, `GET /export`. Writes, `/subscribe` (until REP2), and
  every `/admin/*` + parent surface stay on the primary.
- **Test hook**: env.test sets `REGION_OVERRIDE_HEADER=true`; the worker then
  honors `x-cfb-region: <hint>` so single-colo local stacks can exercise
  region routing deterministically. Never enabled in production configs.

## 6. Lifecycle

- **Creation**: lazy, on first routed read. The replica pulls
  `bootstrap()` from the primary over its own namespace binding (the
  primary's name = its own minus the suffix - no parent involved on the hot
  path).
- **Config changes**: flow through the log (`cfg` entries), so mode changes,
  permission changes, and table DDL apply in write order. The parent still
  pushes only to the primary.
- **Disable** (`auto → off`): the parent tells the primary, which destroys
  every registered replica (close sockets → deleteAll → deferred abort, the
  T1 sequence) and truncates the log. Registry row updated last.
- **Erase fan-out**: `destroyChild` now means "primary destroys its replicas
  first, then itself" - the parent's contract (children die before registry
  rows) is unchanged; the primary's `replicas` table is what makes the
  fan-out complete (§3).
- **Demo projects**: forced `off`; the config push refuses `auto`.

## 7. Observability (the REP1 dashboard payoff)

- Primary RPC `replicationStatus()` → `{ enabled, epoch, lastLsn, logRows,
replicas: [{ region, n, appliedLsn, lagLsn, lastSeenAt }] }`.
- Parent route `GET /admin/replication/:name` forwards it; the db dashboard
  gains a replica map panel (regions + lag, the second-launch demo asset);
  the copilot gains it as an ops tool ("why is EU slow?").
- Analytics: `replica.bootstrap`, `replica.resync` events to DB_EVENTS.

## 8. What REP2 adds (design now, build later)

- Subscribe path routes to the region replica; `LiveShard` runs there
  unchanged (T1 already made the engine role-agnostic - it evaluates
  against local SQLite).
- The tail socket replaces polling pulls while a replica has subscribers;
  writes stream `{ entries }` frames; the replica applies then notifies its
  own subscribers - the primary's per-write cost becomes O(replicas).
- Sibling spawn: at `~25k` sockets a replica answers new `/subscribe`
  upgrades with a `redirect` frame naming `:r:<region>:<n+1>`; the worker
  also spreads new sockets by connection-count hints. (Exact mechanism
  finalized in the REP2 pass; nothing in REP1 precludes it.)

## 9. File plan (REP1)

| File                                       | Change                                                                                                                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents/db/src/replication.ts`             | NEW pure-ish module: log append/prune, apply(entry), feed client (bootstrap/pull), freshness bookkeeping - shared by both classes                                                   |
| `agents/db/src/db/schema.ts` + migrations  | `changelog`, `replicas`, `replica_meta` (applied lsn/epoch, single row) tables                                                                                                      |
| `agents/db/src/live.ts` (`LiveShard`)      | role detection from the instance name; primary/replica branch points                                                                                                                |
| `agents/db/src/collection.ts` / `table.ts` | write path logs images inside `transactionSync`; replica role serves reads from local data; forward-to-primary fallback                                                             |
| `agents/db/src/agent.ts`                   | `replication` in both config shapes + registry column; `getShardRouting`; `/admin/replication/:name`; disable/erase fan-out via primary                                             |
| `agents/db/src/region.ts`                  | NEW static continent/country → hint map                                                                                                                                             |
| `agents/db/src/index.ts`                   | read routing to `…:r:<region>:1` behind the flag cache; test region header                                                                                                          |
| `agents/db/src/schemas.ts` + app mirrors   | config field, status DTOs, `cfb-lsn` header names as constants                                                                                                                      |
| `agents/db/src/client.ts`                  | session bookmark capture + `cfb-min-lsn` on reads                                                                                                                                   |
| dashboard db page                          | replica map panel (Tables + Collections), replication toggle in the designer/access surfaces                                                                                        |
| e2e                                        | `db-replication.api.spec.ts`: enable → routed read via forced region serves from replica; bookmark read-your-writes; horizon resync; disable destroys replicas; demo refuses `auto` |

## 10. Non-goals (REP1)

Live queries on replicas and sibling spawn (REP2); default-on (T3); pinned
region lists; cross-shard anything; write forwarding as a FEATURE (it is a
correctness net, not an API); replica-aware aggregate consistency beyond the
bookmark rule; multi-primary or partitioned writes (post-v2, the log/LSN
composes).

## 11. Risks

1. **Write amplification**: every logged write costs an extra row write
   (+1/M rows written per M writes) and log churn; `off` stays the default
   until T3 and the pricing page's model constants gain the replica terms
   then.
2. **transactionSync + drizzle**: collections write via drizzle's async API;
   the log append must join the same atomic scope. If drizzle's driver
   fights `transactionSync`, the fallback is ordering (data write, then log
   append, with idempotent replay tolerance) - decided at implementation
   with a live workerd smoke, like T1's DDL loop.
3. **Isolate flag-cache staleness** (60s): reads may hit the primary
   briefly after enabling, or a dead replica name briefly after disabling -
   the forward-net makes both correct; document the window.
4. **Epoch discipline**: every path that rewrites data without the write
   path (restore, import) MUST bump the epoch or replicas serve ghosts;
   pinned by an e2e that restores under an active replica.
5. **Session header loss** in third-party proxies: absent headers degrade
   to bounded staleness, never errors.
