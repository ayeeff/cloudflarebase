# DbTable Design — SQL tables on the existing engine (phase T1)

> **Drafted 2026-08-04 — the phase-T1 design for [db-scale-plan.md](db-scale-plan.md).**
> Normative for the T1 implementation, same role db-agent-design.md played for
> v1. No replication here: tables ship on the existing single-DO engine, and
> the substrate lands in REP1. Aggregates and raw SQL are T2; export/import/PITR
> parity for tables is T3.
>
> **Implemented 2026-08-05.** Deviations from this design, for future readers:
>
> - **Names are unique ACROSS kinds**, not per kind (§6 as drafted): the
>   registry PK stays `name`, because per-kind uniqueness would force a
>   composite-PK table rebuild under no-transaction migrations, and one
>   namespace is less confusing anyway. Cross-kind reuse answers 409.
> - **Table access modes are edited in the Tables tab's schema designer**,
>   not the Access tab (§8 as drafted): the admin PUT takes the full desired
>   schema plus modes in one body, so the UI mirrors the contract - one form,
>   one save. The plain-English sentence lives under that form.
> - The live engine was extracted into a shared `LiveShard` base class
>   (`live.ts`) and the access gate into `access.ts` - the "shared module"
>   of §5, shaped as inheritance rather than parameterized functions.
> - Implementation surfaced a pre-existing platform bug: answering a
>   body-bearing request without consuming the body wedges the whole worker
>   ("Can't read from request stream after response has been sent"). Every DO
>   fetch/onRequest path and the entry worker now drain unread bodies
>   (`drainUnusedBody` in access.ts) - this fix covers collections too.

## 1. Shape

One new Durable Object class in `@cloudflarebase/db`: **`DbTable`**, one
instance per table, named `<projectId>:<tableName>` in its own namespace (no
prefix needed - the namespace separates it from `DbCollection`). `DbAgent`
stays the single per-project coordinator; its registry grows a `kind`
discriminator. The wire envelope for a row is deliberately identical to a
document - `{ id, data, owner, createdAt, updatedAt }` with `data` as the
column-value map - so the live-query frames, the SDK's subscribe machinery,
and the dashboard's change handling are reused verbatim rather than forked.

What makes a table a table:

- **Declared columns, real DDL.** The operator declares typed columns; the
  instance holds one physical SQLite table with real columns and real
  indexes. Queries hit typed columns directly instead of `json_extract` over
  a JSON blob.
- **ORM-compatible storage, by construction (user decision).** The physical
  table is named after the declared table and the system columns are plain
  reserved names - `id`, `owner`, `created_at`, `updated_at`, refused as
  user column names - so ORM-generated SQL (`select "id", "title" from
"todos"`) reads and writes the real schema unmodified. Naming lands in T1
  because renaming later is a data migration; the SQL execution surface
  itself is T2 (§13).
- **Schema-first, never auto-created.** Unlike collections (first write
  auto-creates), a table must be declared via `PUT /admin/tables/:name`
  before any data traffic; an unregistered table 404s. SQL means schema.
- **Single-table by construction.** No joins, no cross-shard anything - the
  same v1 stance as collections, and the property that makes live SQL queries
  tractable.
- **Two views, one storage.** The ORM/SQL view is the flat row; the
  realtime/SDK view is the document envelope (`data` = column map). Same
  bytes, two read shapes.

## 2. Column DSL (`schemas.ts` additions)

```
tableNameSchema   = collectionNameSchema (same grammar; also the physical
                    SQLite table's name, quoted in all generated SQL)
columnNameSchema  = /^[a-z][a-z0-9_]{0,63}$/   // no leading underscore
                    (reserved for future system use); no hyphens: column
                    names appear in dotted query field paths. The system
                    columns are PLAIN reserved names - id, owner,
                    created_at, updated_at - refused as user columns, so
                    the SQL view reads like a normal table
tableColumnSchema = strictObject({
  name: columnNameSchema,
  type: enum(['text','integer','real','boolean','json']),
  nullable: boolean default true,
  default: scalar optional,        // must type-match; required when
                                   // nullable=false is ADDED later (SQLite
                                   // demands a default for ADD COLUMN NOT NULL)
  unique: boolean default false,   // implemented as a UNIQUE index
  index: boolean default false,
  // rules-lite extras, enforced in JS on the public write path (NOT CHECK
  // constraints - CHECK cannot be added or altered later):
  maxLength / min / max / enum     // same bounds grammar as fieldRuleSchema
})
tableModesSchema  = collectionModesSchema minus `validator`, plus
                    columns: array(tableColumnSchema).min(1).max(64)
```

`MAX_COLUMNS = 64`, `MAX_INDEXES = 16` (unique + index combined). Booleans
store as integer 1/0 (the existing `bind`/`norm` convention); `json` columns
store JSON text and materialize parsed in the DTO, so `getPath` and the JS
matcher work on rows unchanged. **SQLite affinity is not the type system**:
it would happily store text in an integer column, so the write path validates
values strictly against the declared type in JS before binding - the same
place rules-lite bounds run.

`TableConfig` mirrors `CollectionConfig` (projectId, name, access modes,
read/write permissions, allowedOrigins, demo, configVersion) with `kind:
'table'` and `columns` in place of `validator`. One `configVersion` covers
modes and schema; the child's cached meta additionally records
`appliedColumns`/`appliedIndexes` - **the applied-schema record replaces
introspection, because `pragma_table_info()` is blocked (`SQLITE_AUTH`)**.

## 3. DDL apply (pure module `table-schema.ts`)

`planDdl(table, applied, declared)` returns either `{ statements: string[] }`
or a refusal, and is unit-tested exhaustively:

- New column → `ALTER TABLE "<table>" ADD COLUMN "name" TYPE [NOT NULL
DEFAULT lit]`. SQLite requires a default to backfill NOT NULL adds; the
  PLANNER refuses that pairing's absence (the zod layer deliberately allows
  NOT-NULL-without-default - it is the "required on write" declaration for
  columns present since creation).
- New `index`/`unique` → `CREATE [UNIQUE] INDEX`. Uniquifying an existing
  column may genuinely fail on duplicate data: the child reports the SQLite
  error and the parent answers 409 with it - the operator resolves the dupes.
- Removed column, changed type, removed NOT NULL, renamed column → **refused
  with 400 by the parent before any push** (diffed against the registry's
  stored columns). Destructive migrations are export → recreate → import
  territory (T3 tooling; until then, recreate).
- Bounds/enum rule changes are metadata-only - no DDL, config push alone.

All generated SQL quotes identifiers; values are always bound. The physical
table lives entirely outside drizzle (dynamic columns cannot be modeled);
drizzle still runs the shared migrations in `DbTable`, where `subscriptions`
and `collection_meta` are used and every other table stays empty - the
established one-pipeline pattern.

## 4. Query DSL over tables (pure module `table-query.ts`)

The same `querySchema` - `where`/`orderBy`/`limit`/`cursor` - with field
resolution against the declared schema at compile time:

- A single-segment field must be a declared column → compiles to `"col" op ?`.
- A dotted path is allowed only when its FIRST segment is a `json` column →
  compiles to `json_extract("col", '$.rest')`, reusing the regex-validated
  interpolation argument from v1.
- An unknown column or an illegal dotted path is a 400 (`invalid-query` on
  the socket), decided in the compiler where the config is at hand.

`compileTableQuery(query, columns, options)` mirrors `compileQuery` clause
for clause (including the `IS NULL` / Firestore `!=` / `array-contains`-on-
json semantics, cursor keyset continuation, and owner scoping via the real
`owner` column). **The JS matcher and order comparator are not duplicated**:
`matchesQuery`/`orderComparator`/`getPath` from `query.ts` already operate on
the DTO's data map and apply as-is, because json columns arrive parsed and
booleans normalize identically. The new unit suite `table-query.unit.test.ts`
pins compiler↔matcher parity over typed columns exactly the way
`query.unit.test.ts` pins the document pair, plus DDL-planner fixtures.

Windowed live queries (`orderBy`+`limit`, `lastMembership` diffing) transfer
mechanically - `notifySubscribers`/`notifyWindowed` operate on DTOs and
compiled queries, not on document specifics.

## 5. `DbTable` (new `table.ts`)

Structurally `DbCollection` with the document specifics swapped out:

- **Physical schema**: `"<table>"(id TEXT PRIMARY KEY, owner TEXT,
created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ...declared
columns)` created on first `configure()`; `owner` and `updated_at` get
  their indexes at creation. Ids are ULIDs from the existing `ulid.ts`
  (chronological default order).
- **HTTP surface** (hot path `/agents/db-agent/<pid>/tables/<t>/**`):
  `POST /rows` (`{id?, data}`, 201/409), `GET|PUT|PATCH|DELETE /rows/:id`,
  `POST /query`, `GET /subscribe` (WS upgrade, same frame schemas). PATCH is
  a column-level shallow merge validated on the merged result. Writes
  validate strictly: unknown column 400, type mismatch 400, NOT NULL
  violation 400, rules bounds 400 with an `issues` array; UNIQUE violations
  surface as 409 with the offending column named.
- **Access modes**: `public|auth|owner` + `readPermission`/`writePermission`,
  same 401/403 split, owner-mode 404-for-privacy on foreign rows, permission
  gate on subscribe. The guard and CORS logic are extracted from
  `collection.ts` into a shared `access.ts` (config + verifier in, decision
  out) rather than copied - the T1 refactor, kept behavior-identical for
  collections.
- **RPC surface**: `configure()` (applies the DDL plan before persisting
  meta; a DDL failure throws so the parent can surface it and the registry
  row keeps the previous columns), `adminQuery`, `adminPut(id, data,
ifAbsent)` with the same 409 contract, `adminDelete`, `getRowCount`,
  `destroy()` (close sockets → deleteAll → deleteAlarm → deferred abort,
  verbatim). The `DbDocument`-in-RPC `never`-collapse gotcha applies to
  `DbRow` returns identically - same documented casts at the call sites.
- **Live queries**: `subscriptions` table, hibernation design, token-expiry
  laziness, fresh-snapshot reconnects - all shared code paths, not parallel
  implementations, wherever extraction is mechanical (`acceptSubscriber`,
  frame handling, and the notify pass move to a shared module parameterized
  by the compiled-query pair; anything truly document-specific stays behind).
- **Demo caps**: 200 rows/table, 8 KB rows; always-on 128 KB rows. The
  project shard cap becomes ONE pool across kinds: 200 shards per project
  (demo 5) - `checkCollectionCap` generalizes rather than doubling.
- **Analytics**: `row.created|updated|deleted`, `table.*` lifecycle events,
  shared subscription events - same AE schema, table name in the collection
  blob position.

## 6. `DbAgent` changes

- **Registry**: the `collections` table gains `kind` (`'collection'`
  default) and `columns` (JSON, tables only); `restore_points` gains `kind`
  for T3. Name uniqueness is per kind (different namespaces); the dashboard
  discourages reusing a name across kinds but nothing breaks.
- **Admin surface**: `PUT /admin/tables/:name` (declare/alter: validates,
  diffs against stored columns, refuses destructive diffs 400, row-first-
  then-push like collections; a child DDL failure rolls the row's columns
  back to applied and surfaces 409/400), `DELETE /admin/tables/:name`,
  `PUT|DELETE /admin/tables/:name/rows/:id` (`?ifAbsent=1` → 409), and
  `/admin/query` extended to accept exactly one of `collection` or `table` -
  one operator query surface for both engines, which is also what the
  copilot tool keeps calling.
- **State**: `DbAgentState` gains `tables: DbTableSummary[]` (name, columns,
  modes, permissions, rows) and `totalRows`; `syncCollectionsState`
  generalizes to both kinds and keeps the existing on-wake re-derivation so
  persisted pre-table state upgrades without failing the console's parse.
- **Erase fan-out**: `destroyChild(kind, name)` picks the namespace and
  verifies wipes via the matching count RPC; project destroy iterates both
  kinds, children first, registry surviving until every child confirms.

## 7. Worker, packaging, manifest

- `index.ts`: second hot-path regex `/agents/db-agent/<pid>/tables/<t>/**` →
  `DbTable` stub (one hop, includes `/subscribe`), same 5xx reporting;
  exports `DbTable` wrapped in Sentry like its siblings.
- **Wrangler**: `DbTable` binding in every env block of
  `agents/db/wrangler.jsonc` + `new_sqlite_classes: ["DbTable"]` under the
  next migration tag. The template fragment adds the same under ITS next
  tag; the CLI's fragment-merge already appends by next-free-tag - the
  packed-tarball double-add test in D-phase style verifies a consumer
  upgrade lands `DbTable` as v2 without touching v1.
- **Manifest**: `durableObjects` += `{ "class": "DbTable", "scope":
"perTable" }`, routes += `{ "path": "/tables/*", "access": "public" }`.
  The `scope` enum widens in BOTH schema copies (app `agent-registry.ts`,
  CLI `manifest.ts`) in the same release - an old copy refusing the new
  value is exactly the drift the single-sourcing exists to catch.
- Bindings contract (`bindings.ts`/`bindings.test-d.ts`) is unchanged -
  `DbTable` is a class the consumer's config declares, not an env binding
  the entrypoint asserts… except the namespace self-binding: `DbTable`
  joins `DbCollection` in `DbAgentBindings` and the test-d negatives.

## 8. Web app (registry-driven where the rails already run)

- **Proxies**: `api/projects/[projectId]/db/tables/[...path]` public
  passthrough mirroring the collections one (Authorization forwarded; WS
  goes direct via `/agents/*`). Admin traffic rides the existing
  `db/admin/[...path]`. Guard classification follows the manifest's new
  `/tables/*` route automatically once the mirrors land.
- **Dashboard** (`/dashboard/[projectId]/db`): a Tables area beside
  Collections - create form with a column editor (name/type/nullable/
  default/unique/index + bounds), a real data grid whose columns come from
  the declared schema (this is the T1 screenshot), row editor with ULID
  minting from `src/lib/ulid.ts` for blank ids, per-table Access tab
  rendering the same plain-English sentence, Integration snippets for
  `db.table(...)`. Visual work goes through a variant picker before rollout.
- **Mirrors**: `src/lib/agents.ts` adds the column DSL, table config/summary,
  and admin-body schemas with `.meta({ id })`; `src/lib/openapi/db.ts` adds
  the `/tables/...` paths and component schemas.
- **Copilot**: the tables summary rides `/overview` into the existing
  overview tool for free; the query tool gains the `table` parameter, and
  the system prompt injects declared columns for registered tables -
  schema-grounded answers with zero new plumbing.

## 9. SDK (`client.ts`)

`createDbClient(...)` gains `table(name)`. `CollectionHandle` generalizes to
one shared handle parameterized by path segment (`collections`/`tables`) -
CRUD, query, subscribe, reconnect/backoff, comparator-sorted local docs are
identical by construction. Tables expose `create/get/update/patch/delete/
query/subscribe` in T1 (aggregate arrives with T2, export with T3). Optional
compile-time typing: `table<T extends Record<string, unknown>>(name)` types
`data` as `T` through the handle - zero runtime cost, real DX.

## 10. ORM compatibility (user decision)

The SQL layer must be drivable by ORMs - drizzle and prisma named
explicitly. What that means concretely, and when each piece lands:

- **T1 (this phase): the storage is the contract.** Physical table named
  after the declared table, plain reserved system columns, real types and
  indexes - ORM-generated SQL matches the schema on disk. This is why the
  naming ships now: it is the only part that would be a data migration
  later.
- **T2: a D1-shaped execution surface.** The per-table SQL endpoint takes
  D1's request/response contract (`{sql, params}` in, D1-style results out)
  rather than a protocol of our own, because `drizzle-orm/d1` and prisma's
  D1 driver-adapter pattern already speak it - official adapters become
  thin shims (`@cloudflarebase/db/drizzle` first, prisma adapter after).
  Single-table SQL only; statements are classified (SELECT vs DML), DML
  runs `RETURNING` capture so live queries (and later the replication log)
  fire identically to typed CRUD, and every write funnels through the same
  `table-schema.ts` validation. Reads route to replicas once REP1 lands.
- **The column DSL stays the schema source of truth.** ORMs are runtime
  clients; drizzle-kit/prisma-migrate DDL is not accepted (the endpoint
  refuses DDL statements). The inverse direction ships instead: schema
  codegen from declared columns (`cloudflarebase pull` emitting a drizzle
  schema, prisma models later) so the ORM's types always mirror the
  declared truth.
- **Transactions**: single-statement atomicity is native; a D1-style
  `batch` (one table, one implicit transaction via `transactionSync`) is
  the T2 shape. Cross-table transactions remain out of scope - shard
  independence is the topology.

## 11. e2e

Same self-seeding regime (`DB_PROJECT`/`SCRATCH_PROJECT`, seed counts never
touched): `db-tables.api.spec.ts` (declare, additive alter, destructive-alter
400, unique-conflict 409, CRUD + typed query semantics + json-column dotted
paths, three access modes, owner isolation, ifAbsent 409, caps),
`db-tables-live.api.spec.ts` (snapshot/deltas/windowed displacement over a
typed orderBy, auth errors, direct :8799 and through the built worker),
console-guard additions (tables admin 401s, `/tables/*` public), demo-project
additions (declare + CRUD + caps unauthenticated), dashboard UI spec for the
Tables tab behind `gotoAuthPage`-style hydration gates, and the OpenAPI spec
asserting the new paths. Unit: `table-schema` DDL planner + `table-query`
parity suites run in the same node:test pipeline.

## 12. Non-goals (T1)

Joins and cross-shard reads/writes; aggregates and the SQL execution
surface (T2, §10); export/import/PITR/checkpoints for tables (T3);
replication (REP1+); composite indexes; column drop/rename/retype tooling;
CHECK constraints, foreign keys, generated columns; ORM-authored migrations
(drizzle-kit/prisma-migrate emit DDL we refuse - the column DSL is the
schema source of truth); table-level validators beyond per-column bounds
(the column DSL is the validator); collation/non-ASCII ordering guarantees
beyond v1's documented "unspecified".

## 13. Risks

1. **Affinity looseness** - typed columns only mean something because the JS
   write path enforces them; any write path that skips validation (a future
   import) must reuse the same module. Mitigation: validation lives in
   `table-schema.ts`, not inline.
2. **DDL failure states** - a child that dies mid-`configure` (multiple
   ALTERs are not transactional under DO SQLite's no-BEGIN rule) re-applies
   idempotently: the planner diffs against `appliedColumns`, and each
   statement is individually idempotent-checked before running (add column
   present → skip). The plan, not hope, is what makes partial application
   safe.
3. **Registry state-shape upgrade** - existing production `DbAgent` DOs wake
   with pre-table persisted state; the on-wake re-derivation (already in
   place for v1's summary growth) must cover the new fields or the console
   overview parse fails exactly for projects holding data.
4. **Two hot paths** - the entrypoint regex pair must stay mutually
   exclusive (`/collections/` vs `/tables/`); a name is only ever routed by
   its own kind's namespace, so a kind-name collision cannot cross wires.
5. **Manifest schema widening** - app and CLI copies must accept
   `perTable`/new route in the same release train as the package publish, or
   `add db` on a fresh consumer breaks. The release checklist pins the
   order: app + CLI merge first, package publish second.
