# Join Design — read-only join views over the replication feed

> **Drafted 2026-08-16 — NOT implemented.** Normative for implementation when
> scheduled, same role [db-replication-design.md](db-replication-design.md)
> played for REP1. Supersedes the "table groups" line in
> [db-scale-plan.md](db-scale-plan.md) non-goals: co-locating primaries is no
> longer the plan for joins.
>
> The premise: REP1 already gives every shard a row-image changelog that other
> Durable Objects bootstrap from and then follow. A region replica is a DO that
> follows ONE primary into a copy of ONE table. Nothing in that machinery is
> inherently single-source. **A join view is a replica that follows N primaries
> into one SQLite** - so joins become a read-side feature built on a substrate
> that already exists, instead of a rewrite of the write path.
>
> The prize is not catching up to Postgres. It is **live joins**: the view holds
> every member row locally, so a join can be subscribed to. Firebase cannot do
> that at all.
>
> **JOIN1 implemented 2026-08-16.** Deviations, for future readers:
>
> - **Views do NOT register in a member's `replicas` table** (§4 as drafted).
>   They follow the same feed, but `destroyReplicaInstances` resolves every
>   registry row as `<shardName>:<id>` in the SHARD's own namespace - for a
>   view id that names a different Durable Object entirely, so the primary
>   would have destroyed an empty stranger while the real view survived. One
>   guard in `registerReplica` (ignore anything not `r:`) fixes the replica
>   map, the sibling-spawn counts, and the erase path at once. The PARENT owns
>   a view's lifecycle instead, which it must anyway: only the parent knows a
>   view's whole membership.
> - **One instance per view, not one per region.** The name grammar keeps the
>   region slot and JOIN1 always fills it with `global`. A view already stores
>   a second copy of every member; multiplying that by regions is a latency
>   optimization for a feature whose first job is being correct. Making views
>   regional later is a change in `index.ts` and nowhere else.
> - **No `readAccess` on a view.** Raw SQL always requires a project JWT (the
>   table endpoint's rule), so the field could only ever hold `auth`. The gate
>   is stated exactly instead: a valid token, plus the view's key, plus EVERY
>   member's key. `public` members are read through a token here - stricter
>   than reading them directly, never looser.
> - **The owner-mode refusal is enforced at three edges**, not one: declaring
>   a view over an owner-scoped table (400), flipping a member to owner-scoped
>   or replication-off afterwards (409, naming the view), and at read time in
>   the view itself - the member config it checks comes from that member's own
>   feed, so a member that changed underneath is caught before it is served.
> - **The member-permission check runs AFTER `freshen()`, and fails closed.**
>   Drafted, it ran first - and member configs arrive from each member's FEED,
>   so before the first bootstrap there are none, and checking permissions
>   against an empty config set passes everything. An unentitled token read a
>   permission-gated member through a brand-new view, on that view's FIRST
>   request only, which is the worst possible shape for a hole. Caught by
>   `db-views.api.spec.ts` on the first run. A member whose config is still
>   missing after freshening now answers 503: "we do not know what this table
>   requires" can never mean "so let it through".
> - Deleting a table a view covers is refused (409) rather than cascading: a
>   view missing a member is invalid, not degraded.
> - `view_sources` joined `RESERVED_SHARD_TABLES` and the SQL gate's
>   internal-name blocklist, so a view cannot read its own bookkeeping and no
>   table can be declared with that name.

## 1. Shape

A **view** is a third shard kind beside `collection` and `table`: one Durable
Object holding read-only copies of N member tables in one SQLite, kept current
from each member's change log.

| Role     | Instance name                 | Holds                                              |
| -------- | ----------------------------- | -------------------------------------------------- |
| primary  | `<pid>:<name>`                | authoritative data + change log + replica registry |
| replica  | `<pid>:<name>:r:<region>:<n>` | a copy of ONE table                                |
| **view** | `<pid>:v:<view>:<region>:<n>` | copies of EVERY member table                       |

```
tables (primaries, unchanged)          join view (new, read-only)
  todos    ──changelog──┐
  users    ──changelog──┼──►   one DO, one SQLite, all three tables
  projects ──changelog──┘        SELECT … FROM todos JOIN users ON …
```

Writes never touch a view; they go to the member primary exactly as today. A
view answers `POST /views/:name/sql` with SELECT only, and (JOIN2) `GET
/views/:name/subscribe`.

**Views are per region and lazily created**, like replicas: the first read from
a region materializes one there. A project with no join traffic pays nothing.

### Why not table groups

Co-locating primaries in one DO buys cross-table transactions and foreign
keys, but every member then shares one thread and one 10 GB budget, the hot
path gains a table→group lookup it does not pay today, and existing tables need
migrating. That is a large change to the write architecture for a guarantee
most callers asking for joins do not need. Views are **purely additive**: no
existing shard changes behaviour, write scale is untouched, and nothing has to
migrate. The cost is honest and stated up front - read-only, eventually
consistent, member data stored twice.

Table groups remain the answer if cross-table **transactional writes** ever
become the ask. The two designs compose; neither forecloses the other.

## 2. Phasing

**JOIN1 needs no primary LOGIC at all.** `repBootstrap`, `repSnapshotChunk`,
and `repPull` already serve any caller that registers itself
([table.ts:469](../agents/db/src/table.ts#L469)) - so a pull-based view is a
new consumer of an existing feed, exactly REP1's model.

One line is the exception, and it is a deployment-ordering fact rather than a
design one: `repPullInputSchema` validates `replicaId` against
`/^r:[a-z-]+:\d+$/` ([schemas.ts:236](../agents/db/src/schemas.ts#L236)), so a
view's `v:<view>:<region>:<n>` is refused by zod before any handler runs. The
regex has to admit both spellings, and **every deployed agent must carry that
widening before a console can declare a view** - the same lesson as widening
the project-id ceiling to 48 characters ahead of minting a longer id.

- **JOIN1 — pull-based read-only views.** New DO class, registry kind, routing,
  widened SQL gate. The view serves a read if it pulled within `MAX_LAG_MS`
  (3s, REP1's window); otherwise it pulls every member first. No primary
  changes.
- **JOIN2 — live joins.** Views register for pushes the way replicas do, and
  each applied row image re-runs the subscribed joins and diffs by row id -
  the windowed-query path, which already handles displacement. This is where
  the primaries gain a push-flag case (§7).
- **JOIN3 — ORM + console.** `schema generate` emits drizzle relations,
  `@cloudflarebase/db/drizzle` gets a view handle, and the dashboard gains a
  view designer plus a "joins" surface on the db page.

## 3. Declaring a view

`PUT /admin/views/:name` on `DbAgent`, mirroring `PUT /admin/tables/:name`:

```jsonc
{
	"members": ["todos", "users"], // declared tables, 2..5
	"readAccess": "auth", // never wider than any member (§5)
	"readPermission": "reports:read" // optional, in addition to members' keys
}
```

Registry storage reuses the existing `collections` table
([db/schema.ts:20](../agents/db/src/db/schema.ts#L20)) - `name` stays the sole
primary key, so a view name is unique across all three kinds, and `kind` gains
`'view'`. Members go in a new nullable `members` column (JSON `string[]`),
additive like `columns` was for tables.

Constraints checked by the parent before anything is pushed:

- Every member must exist, be `kind: 'table'`, and have `replication: 'auto'` -
  `repBootstrap` refuses a shard that is not replicating
  ([table.ts:474](../agents/db/src/table.ts#L474)), so an `off` member cannot
  be followed. Flipping a member to `off` while a view covers it is refused.
- **No member may use `owner` access mode** (§5).
- 2..5 members per view, 3 views per project; views count toward the existing
  200-shard project pool. Demo projects get none (a demo is throwaway state;
  duplicating its rows for reporting queries is pure cost).
- Collections are not eligible in v1 (§10) - tables only.

## 4. The multi-source replica

The replica side is already shaped right. `applyLogEntry`, `applyRowImage`, and
the pull loop ([table.ts:688](../agents/db/src/table.ts#L688)) transfer almost
verbatim; what has to widen is everything that assumes exactly one source:

| Single-source assumption                                       | Where                                                      | Change                                                                          |
| -------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `replica_meta` is one row (`WHERE id = 1`)                     | [replication.ts:325](../agents/db/src/replication.ts#L325) | New `view_sources(table PK, epoch, applied_lsn, pulled_at)` - a position vector |
| Role parses `primaryName` off the `:r:` suffix                 | [replication.ts:34](../agents/db/src/replication.ts#L34)   | Third role `view`; members come from config, not from the name                  |
| One physical table per DO (`requireTableName`, `this.columns`) | [table.ts:745](../agents/db/src/table.ts#L745)             | Parameterize apply by `(table, columns)` - mechanical                           |
| `repApply` answers `{stop}` with no subscribers                | [table.ts:431](../agents/db/src/table.ts#L431)             | JOIN1 sidesteps it (pull-only); JOIN2 adds a "reads too" push reason            |

Bootstrap runs the existing sequence **once per member**: `repBootstrap` (which
registers the caller durably before data leaves), then `repSnapshotChunk` pages,
then the member's starting LSN into `view_sources`. Steady state pulls each
member independently. Members are independent by construction - one member's
resync never invalidates another's position.

**The view's DDL comes from the feed.** `cfg` entries carry each member's
config, and `configure()` already plans and applies table DDL, so a member's
schema change replicates into the view in write order with its data. The view
never introspects and never guesses.

### Registry-id collision (a real detail, not a nit)

A view registers itself in each member's `replicas` table, whose id is the
instance-name suffix. `regionSocketCounts` derives the sibling index with
`row.id.split(':')[2]` ([replication.ts:286](../agents/db/src/replication.ts#L286)),
which reads `1` from `r:weur:1` but `weur` from a naive `v:sales:weur:1`.
Sibling accounting must therefore ignore non-`r:` registrations explicitly
rather than by accident. Views appear in `/admin/replication/:name` and the
Replication tab, labelled as views - that is useful (a member's operator can
see what follows it), but it must not distort the spawn picker.

## 5. Access control — the part to get right first

A join is a data-flow between tables, so the view's read gate must be **at
least as strict as every member's**, never a union of them. The view knows each
member's access config locally, because config arrives through the feed.

- A read of a view requires passing **every member's** read mode and
  `readPermission`, plus the view's own optional `readPermission`. All checks,
  not any.
- **`owner`-mode tables cannot be members.** Row-level ownership does not
  survive a join: `todos JOIN users` where `todos` is owner-scoped leaks the
  joined `users` rows selected by another owner's todos, and the general fix is
  a row-level-security engine, which this is not. Refused at declare time with
  that reason, and re-checked when a member's mode changes (flipping a member
  to `owner` while a view covers it is refused, like flipping replication off).
- Views are **never public-writable, never writable at all**: the gate accepts
  SELECT and nothing else, so the whole DML surface is absent rather than
  guarded.
- Raw SQL on a view always requires a project JWT, matching the table SQL
  endpoint's rule - public modes never open raw SQL.

## 6. The SQL gate

`table-sql.ts` widens, and gets _simpler_ for this kind: with no DML to police,
the target-table checks and the automatic `RETURNING` disappear. What survives
is exactly what earns its keep - single statement, no DDL/PRAGMA/transactions,
no internal-table references (string literals included), and the unterminated
block-comment refusal.

Joins across members need no allowlist: **the only user tables in the view's
SQLite are its members**, so a reference to anything else fails naturally. That
is the same property that makes the current single-table gate safe, applied to a
set instead of one name.

CTEs already front SELECTs today, and window functions, subqueries, and
`GROUP BY` come along for free - they were never blocked, only unavailable
across tables.

## 7. Freshness and read-your-writes

Views are **explicitly stale-tolerant**, and the docs must say so plainly rather
than bury it: a view read may be up to `MAX_LAG_MS` (3s) behind, less under
JOIN2 pushes.

`cfb-lsn` is a per-shard scalar, and a view has a position per member - a
vector. v1 does not invent a compound bookmark:

- A read carrying `cfb-min-lsn` **for a named member** (`cfb-min-lsn:
todos=418`) forces that member's pull before serving. The SDK sends it when
  the caller's session has written to a member the query touches.
- Anything unsatisfiable after a pull is answered by pulling again, never by
  serving known-stale data silently; a member whose primary is unreachable
  fails the read rather than returning a partial join.
- A general multi-source bookmark (vector clocks over members) is deferred
  until someone needs it. Stating "joins are eventually consistent" is a
  smaller lie than a bookmark that is only sometimes honoured.

## 8. Lifecycle

- **Creation**: lazy, on first routed read in a region; bootstrap per member.
- **Member config change**: flows through that member's `cfg` entries.
- **Member dropped**: the view is dropped with it. A view missing a member is
  not degraded, it is invalid - and leaving a half-view serving joins over a
  table the operator deleted is the wrong failure. The parent refuses the
  member delete unless the view is deleted first, naming the view.
- **Erase fan-out**: views are destroyed BEFORE their members, by the parent -
  not by the member primaries. Each member's `replicas` registry lists the view,
  so the primary-destroys-its-replicas rule would have the first member erased
  take the view down while other members still list it. The parent owns views
  because only the parent knows the whole membership.
- **PITR**: restoring a member bumps its epoch, and the view re-bootstraps that
  member only. Views themselves are not restorable - they hold no authority.

## 9. File plan (JOIN1)

| File                                      | Change                                                                                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `agents/db/src/view.ts`                   | NEW `DbView` class: multi-source bootstrap/pull, local SELECT execution, freshness window                                                |
| `agents/db/src/replication.ts`            | `view` role parsing; per-source meta helpers; sibling-count parse guarded to `r:` ids                                                    |
| `agents/db/src/db/schema.ts` + migrations | `members` column on the registry; NEW `view_sources` table                                                                               |
| `agents/db/src/schemas.ts` (feed input)   | `repPullInputSchema.replicaId` admits `v:<view>:<region>:<n>` - must be DEPLOYED before any console declares a view                      |
| `agents/db/src/table-sql.ts`              | SELECT-only mode for views (drops DML target checks and auto-RETURNING)                                                                  |
| `agents/db/src/agent.ts`                  | `kind: 'view'` registry, `PUT/GET/DELETE /admin/views/:name`, declare-time constraints, erase order                                      |
| `agents/db/src/index.ts`                  | `/views/<v>/**` routing to the region view instance, behind the existing isolate cache                                                   |
| `agents/db/src/schemas.ts` + app mirrors  | view config + DTOs; `cfb-min-lsn` member form                                                                                            |
| `agents/db/src/client.ts`                 | `db.view('<name>').sql(...)`; member-scoped bookmark send                                                                                |
| `src/lib/openapi/db.ts`                   | view routes in the generated reference                                                                                                   |
| e2e `db-views.api.spec.ts`                | join returns joined rows; stale-read window; owner-mode member refused; member delete refused; erase order; non-member table unreachable |
| unit `view-sql.unit.test.ts`              | the SELECT-only gate, against the same bypass corpus as `table-sql.unit.test.ts`                                                         |

## 10. Non-goals (JOIN1)

Writes through views, cross-table transactions, foreign-key enforcement,
joining collections (the feed is identical, so it composes later - but a
document store has no columns to join on without a declared projection),
cross-project joins, materialized aggregates, and any join that spans a shard
the caller could not read directly. Table groups stay unbuilt.

## 11. Risks

1. **Storage duplication is billed to the operator.** A view over three tables
   stores a fourth copy of them per region. Lazy creation and the 5-member cap
   bound it; the pricing model gains a view term before this ships.
2. **Bootstrap cost of large members.** A view over a 5 GB table copies 5 GB
   before its first answer. Mitigations: bootstrap is per member and resumable,
   the first read is slow rather than failed, and a documented ceiling refuses
   a view whose members exceed it. Wants a real measurement, not an estimate.
3. **One thread per view.** A heavy analytical join blocks that view's other
   reads. Region views spread load naturally; a per-view statement timeout is
   the backstop.
4. **The owner-mode exclusion will surprise people**, because owner mode is a
   sensible default for user-scoped tables and it silently means "not
   joinable". The refusal must name the reason, and the docs must lead with it.
5. **Drizzle relational queries** generate SQL shapes the gate has never seen.
   The gate is a blocklist over a closed table set, which is the right shape
   for this, but JOIN3 needs a corpus of real generated queries run against it.
6. **Eventual consistency in a joined read** is a subtler contract than in a
   single-table read: two members pulled at different instants can show a join
   that never existed as a committed state. Bounded by the freshness window and
   acceptable for reporting reads, which is what views are for - but it must be
   documented in exactly those words, not softened.
