# DB Agent Implementation Plan — `@cloudflarebase/db`

> Pre-implementation design document, kept for the reasoning. The feature
> **shipped 2026-07-29**; where this document and the shipped code disagree,
> the deviation list at the top of [db-agent-plan.md](db-agent-plan.md) is the
> record (notably: manifests are single-sourced, not copied — §A.2 here was
> superseded). Current behavior is documented in `agents/db/CLAUDE.md`.

The second backend primitive after auth: a Firestore-style Documents API with full live
queries (onSnapshot parity), per-collection access modes verified against auth-agent
project JWTs, a thin client SDK, and the full `cloudflarebase.agent.json` manifest
implemented end-to-end for BOTH agents (auth refactored onto the manifest rails first,
zero behavior change).

Authoritative references: root `CLAUDE.md`, `agents/auth/CLAUDE.md`, `docs/agent-contract.md`.
All paths below are relative to `f:\Documents\Cloudflarebase\cloudflarebase.com`.

---

## 0. Architecture overview (locked)

### 0.1 Collection-per-DO topology (locked by user — supersedes single-project-DO)

Platform facts driving it: each DO instance is single-threaded with ~1,000 req/s and
10 GB SQLite; instances per class are unlimited; DOs have no read replicas. Facets were
rejected (child SQLite lives inside the parent DO — isolation, not horizontal scale;
shares the parent's thread). Doc-per-DO was rejected (filtered queries would be
unbounded RPC fan-out; queries need co-located rows). Plain sibling DO instances are
the scaling mechanism, so the unit of sharding is the **collection**.

Two DO classes in `agents/db`:

| Class          | SDK                                                   | Instance name                  | Owns                                                                                                                                                                                              |
| -------------- | ----------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DbAgent`      | Agents SDK `Agent<Env, DbAgentState>`                 | `<projectId>`                  | collection registry (names, access modes, reported doc counts), dashboard state sync via AgentClient, project config (allowedOrigins), operator admin surface, demo TTL scheduling, erase fan-out |
| `DbCollection` | plain `DurableObject` (raw WebSocket Hibernation API) | `<projectId>:<collectionName>` | the documents table for ONE collection, the query engine, the live-query subscription engine, cached access modes/config (pushed from parent), JWT verification, per-collection demo caps         |

Instance naming: `idFromName(projectId + ':' + collection)`. Collision-proof because
`projectIdSchema` is `/^[a-z0-9][a-z0-9-]{0,47}$/` (no `:`) and the new collection-name
schema is `/^[a-z][a-z0-9_-]{0,63}$/` (no `:`), so the first `:` is an unambiguous
separator. Max length 48+1+64 = 113 chars, far under DO name limits (names are hashed).

Why `DbCollection` is a plain DurableObject, not an Agents SDK Agent:

- The public live-query socket must NOT receive SDK protocol frames (`cf_agent_state`
  would broadcast operator data to anonymous clients); suppressing them per-connection
  (`shouldSendProtocolMessages`) is more machinery than not having them at all.
- It needs no state sync, no schedules, no AgentClient addressability — routing it via
  `routeAgentRequest` would leak a second public URL namespace
  (`/agents/db-collection/<name>`) into the console guard for no benefit.
- Raw hibernation APIs (`ctx.acceptWebSocket`, `webSocketMessage`/`webSocketClose`,
  `serializeAttachment`, tags, `getWebSockets`) give exact control over subscription
  survival. (The Agents SDK hibernates too — `hibernate` defaults to `true` in
  `agents@0.17` — but its socket protocol is the wrong shape here.)
- Drizzle `durable-sqlite` + `migrate()` are DO-generic, not Agent-specific: the child
  applies migrations in its constructor under `ctx.blockConcurrencyWhile`.

`DbAgent` stays on the Agents SDK because the dashboard consumes it with `AgentClient`
exactly like `AuthAgent` (state sync, `this.schedule` for the demo TTL).

### 0.2 Routing: exact path → instance mapping

Worker segment stays `db-agent`; there is ONE public URL namespace. The worker
entrypoint (`agents/db/src/index.ts`) dispatches:

| Path                                                                 | Handler                                                                                                                                                         |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                                        | worker: `{ service: 'db-agent', status: 'ok' }`                                                                                                                 |
| `DELETE /internal/projects/:projectId`                               | worker → `getAgentByName(env.DbAgent, id).destroy()`; parent fans out to children. Service-binding-only: `workers_dev: false`, `preview_urls: false`, no routes |
| `/agents/db-agent/<projectId>/collections/<c>` + everything under it | worker → `env.DbCollection.idFromName(projectId + ':' + c).fetch(request)` — the hot data path, ONE hop, includes the `/subscribe` WS upgrade                   |
| any other `/agents/**`                                               | `routeAgentRequest(request, env)` → `DbAgent` (`/overview`, `/config`, `/admin/*`, root WS for AgentClient state sync)                                          |

The worker validates the `projectId` and `<c>` shapes before touching a stub (mirrors
AuthAgent's `projectIdSchema` check; the child re-checks in its `fetch`).
`routeAgentRequest` WITHOUT `cors: true`; both DOs own CORS with AuthAgent's exact
policy (own-origin auto-trusted, exact-origin echo + credentials, `TRUSTED_ORIGINS` env

- per-project `allowedOrigins` pushed from the parent).

Sub-path surface as each DO sees it:

`DbCollection` (public product API; access modes enforced inside; sub-path is what
follows `/agents/db-agent/<pid>/collections/<c>`):

- `POST /documents` — create `{ id?, data }` (id defaults to `crypto.randomUUID()`)
- `GET /documents/:docId`
- `PUT /documents/:docId` (replace; 404 when missing) / `PATCH` (shallow merge) / `DELETE`
- `POST /query` — run a Query (§B.3), returns `{ docs }`
- `GET /subscribe` — WebSocket upgrade for live queries (§B.5)
- `OPTIONS *` — CORS preflight

`DbAgent` (operator surface unless noted):

- `GET /config` — public safe config: `{ projectId, realtime: true }` (no collection names)
- `GET /overview` — `{ projectId, collections: [{ name, readAccess, writeAccess, docs }], state }`
- `PUT /admin/collections/:name` — create/configure `{ readAccess, writeAccess }`
- `DELETE /admin/collections/:name` — drop collection (destroys the child DO, then the registry row)
- `POST /admin/query` — `{ collection, query }`; parent forwards to the child over DO RPC.
  Double hop is fine: operator-only, low volume — and it keeps `collections/*` uniformly
  public in the guard while operator browsing stays operator-gated
- `PUT /admin/collections/:name/documents/:docId` / `DELETE` same path — operator doc
  edit/delete, forwarded over RPC (drives the dashboard document editor)
- `PUT /admin/settings` — `{ allowedOrigins }` (mirrors auth; re-pushed to children)
- root WS — AgentClient state sync for the dashboard (operator; console guard covers it)

DO RPC methods (never HTTP): `DbAgent.destroy()`, `DbAgent.getCollectionConfig(name, opts)`,
`DbAgent.reportCollectionStats(name, stats)`; `DbCollection.configure(cfg)`,
`DbCollection.adminQuery(q)`, `DbCollection.adminPut(id, data)`,
`DbCollection.adminDelete(id)`, `DbCollection.destroy()`.

### 0.3 Per-collection ceilings (document honestly)

Each collection gets its own 10 GB / ~1k req/s / single thread / its own hibernated
subscriber pool. There are no DO read replicas; the read-scale mitigation is push-based
live queries (subscribers receive deltas instead of polling). Cross-collection batches
and transactions are OUT of scope for v1 — shard independence is the point of the
topology and any cross-collection primitive would reintroduce coordination between
sibling DOs. These limits go in `agents/db/CLAUDE.md` and the package README.

### 0.4 Naming and ports

DO classes `DbAgent` + `DbCollection`; DO binding names identical to the class names
(so `routeAgentRequest` maps path segment `db-agent` → binding `DbAgent`). Web-worker
service binding `DB_AGENT`. Worker names: `db-agent` (top-level self-hosted default AND
pinned in `env.production`), `db-agent-local` / `db-agent-test` / `db-agent-preview`.
Ports: dev **8789**, e2e **8799** (auth 8788/8798, web 5173/8797).

---

## 1. Phasing

Each phase lands green (`npm run check`, `npm run lint`, per-package `npx tsc --noEmit`,
`npm test`) before the next starts.

- **Phase A** — Manifest infrastructure + refactor auth onto it. Zero behavior change;
  the existing e2e suite passes untouched.
- **Phase B** — `agents/db` package: both DOs, schema/migrations, query engine, live
  queries, JWT verification, demo caps, template, manifest, unit tests.
- **Phase C** — Web integration: bindings, guard/proxy/registry entries, dashboard
  Database tab, OpenAPI db module, control-plane record, e2e stack boot.
- **Phase D** — Client SDK, CLI (manifest reading + entrypoint fix), e2e specs,
  CI/workflows/publishing, CLAUDE.md updates.

---

## Phase A — Manifest infrastructure + auth refactor (zero behavior change)

### A.1 The manifest files

**Create `agents/auth/cloudflarebase.agent.json`** (shipped in the package: add to
`files` and `exports` as `"./cloudflarebase.agent.json"`):

```jsonc
{
	"manifestVersion": 1,
	"name": "auth",
	"title": "Authentication",
	"description": "Users, sessions, and RBAC on Durable Object SQLite.",
	"packageName": "@cloudflarebase/auth",
	"worker": "auth-agent",
	"durableObjects": [{ "class": "AuthAgent", "scope": "perProject" }],
	"entrypoint": { "assertEnvType": "AssertAuthAgentEnv" },
	"erase": { "method": "DELETE", "path": "/internal/projects/:projectId" },
	"bindings": {
		"ai": true,
		"sendEmail": ["EMAIL"],
		"analyticsEngine": [{ "binding": "AUTH_EVENTS", "dataset": "cloudflarebase_auth_events" }]
	},
	"secrets": {
		"generated": ["BETTER_AUTH_SECRET"],
		"optional": [
			"GOOGLE_CLIENT_ID",
			"GOOGLE_CLIENT_SECRET",
			"CF_ACCOUNT_ID",
			"CF_ANALYTICS_API_TOKEN",
			"SENTRY_DSN"
		]
	},
	"vars": {
		"TRUSTED_ORIGINS": { "default": "", "hint": "Extra origins beyond the deployment's own." },
		"WAE_DATASET": { "default": "cloudflarebase_auth_events" },
		"CHAT_MODEL": { "default": "@cf/meta/llama-3.3-70b-instruct-fp8-fast" }
	},
	"routes": [
		{ "path": "/api/auth/*", "access": "public" },
		{ "path": "/config", "access": "public" },
		{ "path": "/overview", "access": "operator" },
		{ "path": "/analytics", "access": "operator" },
		{ "path": "/chat", "access": "operator" },
		{ "path": "/admin/*", "access": "operator" }
	],
	"proxy": { "apiPrefix": "auth", "agentBasePath": "/api/auth" },
	"permissions": ["users:read", "users:write", "sessions:revoke", "roles:write"],
	"console": {
		"section": "Build",
		"icon": "key-round",
		"pages": [{ "path": "/auth", "title": "Authentication", "testId": "nav-auth" }]
	}
}
```

Notes vs the contract-doc sketch: `manifestVersion` added (integer; readers refuse
unknown majors); `${prefix}` templating dropped for v1 (datasets are the concrete
self-hosted defaults, same as the fragment — account-neutral already); `client` array
deferred to the auth-client work (schema allows it, optional); `proxy` added — it is
what generalizes the app's `/api/projects/<id>/<prefix>/*` mapping (auth's app prefix
`auth` maps onto agent base `/api/auth`); `worker` names the URL segment
(`/agents/<worker>/<projectId>`); `entrypoint.assertEnvType` + `durableObjects[].class`
are what the CLI derives export lines from (§D.2). Route access defaults to `operator`
for anything undeclared — declared-public-by-exception, exactly like today's guard.

**Create `agents/db/cloudflarebase.agent.json`** (Phase B ships it; shown here for the
schema design):

```jsonc
{
	"manifestVersion": 1,
	"name": "db",
	"title": "Database",
	"description": "Firestore-style JSON documents with live queries, one Durable Object per collection.",
	"packageName": "@cloudflarebase/db",
	"worker": "db-agent",
	"durableObjects": [
		{ "class": "DbAgent", "scope": "perProject" },
		{ "class": "DbCollection", "scope": "perCollection" }
	],
	"entrypoint": { "assertEnvType": "AssertDbAgentEnv" },
	"erase": { "method": "DELETE", "path": "/internal/projects/:projectId" },
	"bindings": {
		"analyticsEngine": [{ "binding": "DB_EVENTS", "dataset": "cloudflarebase_db_events" }],
		"services": [{ "binding": "AUTH_AGENT", "service": "auth-agent", "optional": true }]
	},
	"secrets": { "generated": [], "optional": ["SENTRY_DSN"] },
	"vars": {
		"TRUSTED_ORIGINS": { "default": "", "hint": "Extra origins beyond the deployment's own." }
	},
	"routes": [
		{ "path": "/collections/*", "access": "public" },
		{ "path": "/config", "access": "public" },
		{ "path": "/overview", "access": "operator" },
		{ "path": "/admin/*", "access": "operator" }
	],
	"proxy": { "apiPrefix": "db", "agentBasePath": "" },
	"permissions": ["documents:read", "documents:write", "collections:write"],
	"console": {
		"section": "Build",
		"icon": "database",
		"pages": [{ "path": "/db", "title": "Database", "testId": "nav-db" }]
	}
}
```

`scope: "perCollection"` extends the schema's scope enum (`perProject | perCollection`);
consumers of the manifest only need `perProject` classes for URL addressing — the
worker's own entrypoint owns child routing.

### A.2 Where the manifest schema and data live (decision)

Cross-project runtime imports are banned, so the app cannot import
`agents/auth/cloudflarebase.agent.json` directly. Decision — **copied JSON + one app
zod schema**, consistent with the existing "DTOs are deliberately copied" rule:

- `src/lib/agents/manifest.ts` — zod schema (`agentManifestSchema`, strictObject) +
  inferred `AgentManifest` type. Parsing throws at import (like the OpenAPI registry).
- `src/lib/agents/manifests/auth.json`, `.../db.json` — byte-for-byte copies of each
  package's `cloudflarebase.agent.json`, kept in sync like the DTO mirrors (documented
  in both CLAUDE.md files).
- `cli/src/lib/manifest.ts` — a second copy of the zod schema for add-time validation
  (the CLI is its own npm project; same copy rule).
- `src/lib/agents/registry.ts` — the app-side registry: parses the JSON copies and
  joins app-only facts the manifest must not know (deployment concerns):

```ts
export interface AppAgentEntry {
	manifest: AgentManifest; // parsed + validated at import
	binding: 'AUTH_AGENT' | 'DB_AGENT'; // service binding name on the web worker
	devHost: string; // 'localhost:8788' | 'localhost:8789' (AgentClient dev host)
	getFetcher(platform: App.Platform | undefined): Fetcher; // 500s when missing
}
export const AGENT_REGISTRY: Record<'auth' | 'db', AppAgentEntry>;
export function agentByWorkerSegment(segment: string): AppAgentEntry | undefined; // 'auth-agent' -> auth
export function agentByApiPrefix(prefix: string): AppAgentEntry | undefined; // 'db' -> db
```

Icons: the manifest carries a string (`"key-round"`, `"database"`); the dashboard layout
maps names to lucide components in a small `ICONS` record (unknown name → fallback).

### A.3 Guard: manifest-driven `classifyAccess`

Rewrite `classifyAccess` in `src/hooks.server.ts` (same file, same behavior):

- `/agents/<worker>/<projectId>/<subPath>`: `agentByWorkerSegment(worker)`; match
  `subPath` against `manifest.routes` (exact or `/*` prefix). Public → open; everything
  else — including unknown workers and undeclared routes — → operator with `projectId`.
  Reproduces today's auth behavior exactly (`/config`, `/api/auth/*` open).
- `/api/projects/<id>/<prefix>/<rest>`: `agentByApiPrefix(prefix)`; translate to the
  agent-relative path via `manifest.proxy.agentBasePath` + `/<rest>`, match the same
  route table. Auth: prefix `auth` + base `/api/auth` reproduces "rest[0]==='auth' → open".
  App-native exceptions stay beside it: `/api/projects/<id>/config` and `/openapi.json`
  open; `/dashboard` operator; default operator.
- Matching helper `matchesRoute(subPath, routes)` lives in `src/lib/agents/registry.ts`
  (pure function; prefix lists precompiled at import).

`applicationHandle` becomes dispatch: `segments[1]` → `agentByWorkerSegment` →
`entry.getFetcher(platform).fetch(event.request)`; unknown segments fall through to
`resolve(event)`. Guard-first ordering unchanged.

### A.4 Generalized proxies

- **Create `src/lib/server/agents.ts`**: `assertProjectId` (moved), `toNativeResponse`
  (moved), `requireAgent(platform, entry)`, and
  `agentUrl(origin, entry, projectId, subPath)` (uses `entry.manifest.worker`).
- **Keep `src/lib/server/auth-agent.ts` as a thin re-export shim** over the generic
  helpers bound to the auth entry, so the ~12 existing route files and
  `src/lib/server/console.ts` don't churn in Phase A.
- `src/lib/server/registry.ts` `eraseProjectData`: loop over `AGENT_REGISTRY` values,
  build `https://<manifest.worker>` + `manifest.erase.path` with the id substituted,
  `entry.getFetcher(platform).fetch(url, { method })`; failures push `manifest.name`
  ('auth' / 'db'). The existing warning/207 shape is untouched.

### A.5 Sidebar + overview driven by `console.pages`

- `src/routes/(app)/dashboard/[projectId]/+layout.svelte`: replace the hardcoded
  Authentication link with an `{#each}` over `buildNav(projectId)`
  (`src/lib/agents/console-nav.ts`) flattening registry `console` sections into
  `{ section, items: [{ href, title, icon, testId }] }`. `data-testid="nav-auth"` comes
  from `pages[].testId` so `dashboard.ui.spec.ts` stays green. The mobile tab nav
  iterates the same data. `comingSoon` keeps Storage / Functions / Realtime /
  Cron & Queues; in Phase C the Database entry drops out because it becomes a real nav
  item. API Reference stays a hardcoded app-native entry (not an agent page).
- `src/routes/(app)/dashboard/[projectId]/+page.svelte` (overview): same for product
  cards — `product-auth` stays; Phase C adds `product-db`; its `comingSoon` loses
  Database then.

### A.6 OpenAPI: per-agent modules + composer

Restructure `src/lib/openapi.ts` into a directory (`$lib/openapi` import preserved via
`index.ts`):

- `src/lib/openapi/index.ts` — composer. Keeps `buildOpenApiDocument({projectId, origin})`;
  merges modules: schema registry (still throws at import on a missing `.meta({id})`),
  concatenated `tags`, merged `paths`. `ref`/`jsonBody`/`jsonResponse`/`UNAUTHORIZED`/
  `buildComponents` move here as shared helpers.
- `src/lib/openapi/auth.ts` — today's auth content verbatim: `Authentication` +
  `Console` tags, its schema list, its paths (keys identical so `e2e/openapi.api.spec.ts`
  passes unchanged). Exports `{ tags, schemas, paths(base) }`.
- `src/lib/openapi/db.ts` — added in Phase C.

### A.7 Control-plane enabled-agents record

- `src/lib/server/db/schema.ts`: add `project_agent` — `project_id text` +
  `agent text` (composite PK), `enabled_at integer timestamp_ms`.
- `src/lib/server/db/index.ts`: append idempotent `CREATE TABLE IF NOT EXISTS
project_agent (...)` to `SCHEMA_STATEMENTS`.
- `createProject`: after the project row, insert one `project_agent` row per registry
  agent (all agents default-enabled; no per-project opt-out UI in v1).
- Deletion fan-out deliberately does NOT read this table: erase must reach every
  registry agent even when a row is missing (fail-safe, contract rule 6). The table is
  the groundwork the contract asks for; the sidebar keeps reading the static registry
  in v1 (see non-goals).

### A.8 Phase A file list

Create:

- `agents/auth/cloudflarebase.agent.json`
- `src/lib/agents/manifest.ts`, `src/lib/agents/manifests/auth.json`,
  `src/lib/agents/registry.ts`, `src/lib/agents/console-nav.ts`
- `src/lib/server/agents.ts`
- `src/lib/openapi/index.ts`, `src/lib/openapi/auth.ts` (delete `src/lib/openapi.ts`)

Modify:

- `agents/auth/package.json` — add `cloudflarebase.agent.json` to `files` + `exports`;
  fix the duplicate `"typecheck"` key while in there
- `src/hooks.server.ts` — manifest-driven `classifyAccess` + dispatching `applicationHandle`
- `src/lib/server/auth-agent.ts` — shim over `src/lib/server/agents.ts`
- `src/lib/server/registry.ts` — erase loop + `project_agent` rows
- `src/lib/server/db/schema.ts`, `src/lib/server/db/index.ts`
- `src/routes/(app)/dashboard/[projectId]/+layout.svelte`
- `src/routes/(app)/dashboard/[projectId]/+page.svelte`

### A.9 Phase A verification

- `npm run check`, `npm run lint`, `agents/auth: npx tsc --noEmit`
- `npm test` — the FULL suite green with ZERO spec changes (the zero-behavior-change
  proof; `console-guard`, `openapi`, `dashboard.ui`, `registry` specs pin every surface
  this phase rewires)
- Manual: `npm run dev`; sign in, `/dashboard/<id>/auth` loads, sidebar identical,
  delete a project and confirm the auth erase still fires

---

## Phase B — the `agents/db` package

Separate npm project published as `@cloudflarebase/db`. Own lockfile, NOT a workspace.
Copy the auth package's shape exactly: `package.json` (files: `dist`, `template`,
`NOTICE`, `cloudflarebase.agent.json`; exports `.`, `./client`,
`./wrangler-fragment.jsonc`, `./cloudflarebase.agent.json`, `./package.json`),
`tsconfig.json` + `tsconfig.build.json` (build excludes `*.test-d.ts` and unit tests;
never ships `worker-configuration.d.ts` or `env.d.ts`), `drizzle.config.ts`,
`scripts/generate-migrations.mjs` (copied from auth). Dependencies: `agents`,
`drizzle-orm`, `zod`, `@sentry/cloudflare`, `jose` (see §B.6). Dev: `drizzle-kit`,
`typescript`, `wrangler`, `@types/node`, `tsx` (unit tests). Do NOT copy auth's
duplicate `"typecheck"` key bug.

Source layout:

- `src/index.ts` — worker entrypoint (§0.2 routing), Sentry wrappers exactly like
  auth's (`instrumentDurableObjectWithSentry` for BOTH classes, `withSentry` on the
  `WorkerEntrypoint`, the >=500 capture block); exports ONLY handlers + DO classes +
  types (`DbAgentState`, `DbOverview`, `DbDocument`, `AssertDbAgentEnv`, ...)
- `src/agent.ts` — `DbAgent` (coordinator)
- `src/collection.ts` — `DbCollection` (plain DurableObject)
- `src/query.ts` — PURE query module: zod-parsed Query → SQL compiler + JS matcher +
  order comparator (no Workers imports; unit-testable)
- `src/live.ts` — subscription engine helpers (frame codecs, membership diff)
- `src/jwt.ts` — token verification + JWKS cache
- `src/schemas.ts` — every zod schema (§B.3/§B.5), auth-package conventions:
  `strictObject` bodies, `.catch` for env/storage reads, schemas for third-party
  responses (JWKS)
- `src/db/schema.ts`, `src/migrations.ts`, `drizzle/`
- `src/bindings.ts` + `src/bindings.test-d.ts`, `src/env.d.ts`
- `src/query.unit.test.ts`, `src/live.unit.test.ts` — `node:test` via `tsx` (see §B.9)
- `template/worker-entry.ts`, `template/wrangler-fragment.jsonc`
- `cloudflarebase.agent.json` (§A.1), `CLAUDE.md`, `README.md`, `NOTICE`, `LICENSE`

### B.1 SQLite schema (drizzle, single journal applied by BOTH classes)

One drizzle pipeline (one `drizzle/` + one `src/migrations.ts`); both DO classes apply
the same migrations idempotently — tables a class doesn't use stay empty. Simpler than
two drizzle configs; revisit only if the schemas diverge heavily (documented in
`agents/db/CLAUDE.md`).

```ts
// src/db/schema.ts
export const collections = sqliteTable('collections', {
	// DbAgent only
	name: text('name').primaryKey(),
	readAccess: text('read_access').notNull().default('auth'), // 'public' | 'auth' | 'owner'
	writeAccess: text('write_access').notNull().default('auth'),
	docs: integer('docs').notNull().default(0), // last reported count
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	reportedAt: integer('reported_at', { mode: 'timestamp_ms' })
});

export const documents = sqliteTable(
	'documents',
	{
		// DbCollection only
		id: text('id').primaryKey(),
		data: text('data').notNull(), // JSON text
		owner: text('owner'), // jwt.sub for owner-mode stamps
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [index('documents_updated_at').on(t.updatedAt), index('documents_owner').on(t.owner)]
);

export const subscriptions = sqliteTable(
	'subscriptions',
	{
		// DbCollection only
		connId: text('conn_id').notNull(),
		subId: text('sub_id').notNull(),
		query: text('query').notNull(), // canonical Query JSON
		ownerSub: text('owner_sub'), // owner-mode filter, from jwt.sub
		tokenExp: integer('token_exp'), // epoch seconds; null = public
		lastMembership: text('last_membership'), // JSON id[] — ordered+limited queries only
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [primaryKey({ columns: [t.connId, t.subId] }), index('subscriptions_conn').on(t.connId)]
);

export const collectionMeta = sqliteTable('collection_meta', {
	// DbCollection only, 1 row
	id: integer('id').primaryKey(), // always 1
	config: text('config').notNull(), // JSON: modes, allowedOrigins, projectId, collection
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
});
```

Queries run over `json_extract(data, '$.path')` — no generated columns, no per-field
indexes in v1 (non-goal; collection scans are the documented behavior, bounded by the
per-collection shard size). `transaction: false` semantics respected throughout: no
explicit BEGIN/COMMIT, no `pragma_table_info` (DO SQLite blocks both with SQLITE_AUTH).

### B.2 Zod everywhere (locked decision)

Every request/response DTO AND the query DSL are zod schemas end-to-end:

- Agent-side: `agents/db/src/schemas.ts` is the single source — `strictObject` bodies,
  `.catch` for env/storage reads (`demoTtlHoursSchema`-style), a schema for the JWKS
  response (third-party shape). The DOs never touch unvalidated JSON.
- App-side: hand-copied mirrors appended to `src/lib/agents.ts` with `.meta({ id })`
  (`DbQuery`, `DbDocument`, `DbAgentState`, `DbOverview`, `DbCollectionConfig`,
  `DbActivityEvent`, `DbQueryResult`, `DbWriteRequest`, ...) so one definition serves
  typed parsing across the service binding AND becomes OpenAPI components via the
  `z.toJSONSchema` registry, rendered by Scalar on the API Reference page.
- Subscription protocol frames are zod schemas too (§B.5) — validated at runtime on
  both ends (agent inbound, client SDK inbound). WS frames have no OpenAPI paths, so
  they are documented via the components section + the Database tag description
  (the frame schemas get `.meta({ id })` and are added to the registry so Scalar
  renders them under Schemas).
- The client SDK (`@cloudflarebase/db/client`) imports the SAME schemas from
  `../schemas` inside the package — no cross-project import issue exists there.

### B.3 Query DSL (zod grammar)

`querySchema` in `src/schemas.ts`; app mirror carries `.meta({ id: 'DbQuery' })`.

```
Query   := { where?: Clause[] (max 10, AND-only), orderBy?: Order[] (max 2),
             limit?: int 1..200 (default 100), cursor?: string (base64, REST only) }
Clause  := { field: FieldPath, op: Op, value: Scalar | Scalar[] (1..20, 'in' only, no nulls) }
Op      := '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'array-contains'
FieldPath := /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,3}$/ , <=128 chars
Scalar  := string (<=1024) | finite number | boolean | null
Order   := { field: FieldPath, direction: 'asc' | 'desc' }   // doc id is always the final tiebreak
```

Example:

```json
{
	"where": [
		{ "field": "status", "op": "==", "value": "open" },
		{ "field": "priority", "op": "<=", "value": 3 },
		{ "field": "tags", "op": "array-contains", "value": "urgent" }
	],
	"orderBy": [{ "field": "createdAt", "direction": "desc" }],
	"limit": 50
}
```

`src/query.ts` derives BOTH evaluators from one parsed `Query` (parity is the invariant
the unit tests pin):

- **SQL compiler** (snapshots + REST queries): field paths are regex-validated so
  interpolating `'$.a.b'` is injection-free; values are always bound parameters.
  `==` → `json_extract(data,'$.f') = ?` (`IS NULL` for null; booleans bind 1/0);
  `!=` → `json_extract(...) IS NOT NULL AND json_extract(...) != ?` (Firestore
  semantics: excludes docs missing the field; `!= null` → `IS NOT NULL`);
  range ops bind directly; `in` → `IN (?,...)`;
  `array-contains` → `json_type(data,'$.f') = 'array' AND EXISTS (SELECT 1 FROM
json_each(data,'$.f') WHERE json_each.value = ?)` (the json_type guard prevents the
  scalar false-positive json_each would otherwise produce).
  `ORDER BY json_extract(...) ASC|DESC, id ASC LIMIT ?`.
- **JS matcher** (live evaluation on writes) + **order comparator** (client SDK reuses
  it): missing field ≡ null; comparisons are defined only between same-typed values —
  cross-type comparisons are documented as unspecified in v1 (SQLite type ordering vs
  JS differ; same-type behavior is identical and unit-tested).

`cursor` (REST `POST /query` only, never subscriptions): opaque base64 of
`[lastOrderValues, lastId]` issued as `nextCursor` in `DbQueryResult` when the page
filled `limit`; validated by zod, decoded server-side into a compiled
`(orderField > ?) OR (orderField = ? AND id > ?)` continuation.

### B.4 Access control + JWT context

`collectionConfigSchema`: `{ readAccess, writeAccess }`, each `'public' | 'auth' | 'owner'`,
default `'auth'`/`'auth'`. Enforcement in `DbCollection` per request:

| mode   | read (GET/query/subscribe)                                               | write (POST/PUT/PATCH/DELETE)                                                          |
| ------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| public | anyone                                                                   | anyone (no `_owner` stamp)                                                             |
| auth   | any valid project JWT                                                    | any valid project JWT                                                                  |
| owner  | valid JWT; results filtered to `owner = sub`; GET of another's doc → 404 | valid JWT; create stamps `owner = sub`; update/delete require `owner = sub` (else 403) |

Token transport: `Authorization: Bearer <jwt>` on REST; `token` field in the
`subscribe` frame on WS (never a query param — URLs get logged). The response envelope
is `DbDocument = { id, data, owner, createdAt, updatedAt }` (ISO strings) — metadata
outside `data`, so there are no field-name collisions and the zod schema stays exact.

### B.5 Live query engine (the centerpiece)

**Transport.** WS upgrade at `GET .../collections/<c>/subscribe`, accepted with the
raw Hibernation API: `ctx.acceptWebSocket(server, [connId])` (the tag IS the connId,
`crypto.randomUUID()` minted at accept). `ws.serializeAttachment({ connId })` — tiny,
far under the 2 KB attachment limit; everything else lives in the `subscriptions`
table, which is what makes subscriptions survive hibernation AND isolate memory from
correctness. Frames handled in `webSocketMessage(ws, raw)`; `webSocketClose`/`webSocketError`
delete `subscriptions WHERE conn_id = ?`. CORS/origin: the upgrade request's `Origin`
is checked against the same trust list as REST (absent Origin — non-browser clients —
is allowed, as with Bearer REST calls).

**Protocol frames (all zod schemas in `src/schemas.ts`; shared with the client SDK).**

Client → server:

```jsonc
{ "type": "subscribe", "id": "s1", "query": { /* DbQuery, no cursor */ }, "token": "<jwt?>" }
{ "type": "unsubscribe", "id": "s1" }
```

Server → client:

```jsonc
{ "type": "snapshot", "id": "s1", "docs": [ /* DbDocument[] in query order */ ] }
{ "type": "change", "id": "s1", "kind": "added",    "doc": { /* DbDocument */ } }
{ "type": "change", "id": "s1", "kind": "modified", "doc": { /* DbDocument */ } }
{ "type": "change", "id": "s1", "kind": "removed",  "doc": { /* DbDocument */ } }
{ "type": "unsubscribed", "id": "s1" }
{ "type": "error", "id": "s1?", "code": "invalid-query" | "unauthorized" | "token-expired"
                              | "subscription-limit" | "internal", "message": "..." }
```

The socket is bound to ONE collection (no collection field anywhere). A client wanting
two collections opens two sockets — the SDK manages that. Malformed frames get an
`error` without `id`; a failed `subscribe` never registers anything.

**Subscribe flow.** Parse frame → verify token per the collection's READ mode
(`owner` mode records `ownerSub = sub`; `auth` requires a valid token; `public` needs
none) → enforce `MAX_SUBSCRIPTIONS_PER_CONNECTION = 10` → run the compiled SQL query →
send `snapshot` → insert the subscriptions row (with `lastMembership` when the query
has `orderBy`+`limit`; `tokenExp` from the JWT).

**Matching on write.** Every mutation computes `oldDoc`/`newDoc` (one read before
write), then loads `SELECT * FROM subscriptions` (bounded: per-connection cap × active
sockets; rows for dead connections are pruned lazily when `getWebSockets(connId)` comes
back empty). Per subscription:

- `tokenExp` in the past → send `error token-expired`, delete the row (lazy expiry —
  one integer compare on the hot path, no re-verification).
- Owner filter applied to both sides: `ownerOk(d) = !ownerSub || d.owner === ownerSub`.
- **Unlimited queries** (no `limit`+`orderBy` window): pure predicate diff —
  `!before && after → added`, `before && after → modified`, `before && !after → removed`.
- **Windowed queries** (`orderBy` + `limit`): membership depends on the window, so when
  `predicate(old) || predicate(new)` (only such writes can change membership), re-run
  the compiled SQL query, diff the new ordered id set against `lastMembership` →
  emit `added` (entered window, incl. docs displaced INTO the window by a removal),
  `removed` (left window, incl. displaced out), `modified` (still in window and this
  write touched it); persist the new `lastMembership`. This is the v1 docChanges
  semantics for limit windows: correct, at the cost of one re-query per relevant write
  per windowed subscription (documented; per-collection sharding bounds it).

Delivery: for each affected row, `ctx.getWebSockets(connId)[0]?.send(frame)`. Send
failures → treat as close (delete rows). No ordering indexes (`newIndex`/`oldIndex`)
in v1 — the client SDK re-sorts locally with the shared order comparator (non-goal).

**Reconnect semantics.** None server-side: a new socket is a blank slate; the client
SDK re-subscribes and receives a fresh snapshot (documented; resume tokens are a
non-goal). Server restarts (eviction, deploy) close sockets; hibernation does NOT —
frames wake the DO, attachment `connId` + the subscriptions table restore full context
with zero in-memory state.

**Dashboard realtime.** The Database tab does NOT use the public subscribe socket
(operators are not project users and hold no project JWT). Instead: `DbAgentState`
carries a `rev` counter + per-collection counts, bumped by the parent when children
report stats (§B.7); the tab connects with `AgentClient({ agent: 'db-agent', name:
projectId, host: dev ? 'localhost:8789' : location.host })`, and every state update
(plus a 5 s polling fallback, both exactly like the auth tab) triggers a refetch of the
browsed collection through the operator proxy `POST /api/projects/<id>/db/admin/query`.

### B.6 JWT verification without agent coupling (`src/jwt.ts`)

What auth issues (verified in `agents/auth/src/auth.ts`): Better Auth `jwt` plugin,
default **EdDSA/Ed25519** keypair in the project's `jwks` table, claims
`iss = "cloudflarebase:<projectId>"`, `aud = "<projectId>"`, `sub = user id`, plus
`email`, `role`, `permissions`, `exp`/`iat`. Public keys at
`/agents/auth-agent/<projectId>/api/auth/jwks`.

Verification: dependency **`jose`** (^6). Rationale over hand-rolled WebCrypto: correct
JWS/JWK parsing for EdDSA AND RS256/ES256 (operators can override
`jwks.keyPairConfig`), tiny, tree-shakeable, runs on Workers, and Better Auth already
uses it — behavior parity for free. `jwtVerify(token, key, { issuer:
'cloudflarebase:' + projectId, audience: projectId })`; alg allowlist
`['EdDSA','RS256','ES256']`; a `jwtClaimsSchema` (zod, `.catch` nothing — strict)
parses the payload before use.

JWKS acquisition (per `DbCollection`, ordered fallbacks — covers both deployment
shapes):

1. `env.AUTH_AGENT` (Fetcher) — OUR multi-worker deployment: the db worker gets an
   optional service binding to the auth worker;
   `fetch('https://auth-agent/agents/auth-agent/<pid>/api/auth/jwks')` (synthetic host,
   same idiom as the erase fan-out).
2. `env.AuthAgent` (DO namespace) — consumer SINGLE-worker installs where both packages
   share one Worker: `idFromName(pid).fetch('https://auth-agent/agents/auth-agent/<pid>/api/auth/jwks')`
   — the AuthAgent's `onRequest` subPath regex matches this shape. No same-origin HTTP
   fetch fallback: a Worker fetching its own hostname trips recursion protection, so
   the namespace path is the supported single-worker mechanism.
3. Neither binding → `auth` mode requests fail closed with 503
   `{"error":"auth verification is not configured"}` (public mode still works).

Cache: DO storage key `jwks-cache` `{ keys, fetchedAt }`, TTL 1 h; an unknown `kid`
triggers one refetch (rate-limited to 1/min via a storage timestamp) then fails 401.
Imported `KeyObject`s memoized in-memory per kid (cheap re-import after hibernation).
Both bindings are OPTIONAL in `DbAgentBindings` (`AUTH_AGENT?: Fetcher;
AuthAgent?: AnyDurableObjectNamespace`) — degraded binding never breaks public-mode
collections, mirroring auth's guarded-optional philosophy.

### B.7 Coordinator: registry consistency, counters, erase

**Create/configure collection** (`PUT /admin/collections/:name` on `DbAgent`):

1. upsert the `collections` row (modes), 2. push `DbCollection.configure({ projectId,
collection, modes, allowedOrigins, demo })` over RPC, 3. `setState` (collections list +
   `rev`). If step 2 fails the row still exists — the child heals via **lazy pull**: a
   child whose `collection_meta` is empty calls `DbAgent.getCollectionConfig(name,
{ autoCreate: true })` once (parent returns existing config, or auto-registers with
   default `auth`/`auth` modes when the collection is new and under caps) and persists it.
   Auto-create on first write is therefore parent-mediated even on the direct hot path —
   single authority, one extra hop only on first touch. Config changes always re-push;
   the hot data path NEVER does a parent lookup (cached modes in `collection_meta`).

**Counters.** Children own exact counts locally (`collectionMeta.config` +
incremental `docs` maintained on every write — no COUNT(*) scans). Reporting to the
parent is best-effort and debounced: an in-memory timer (~2 s) + `ctx.waitUntil` sends
`DbAgent.reportCollectionStats(name, { docs })` with the ABSOLUTE count (idempotent,
self-healing — a lost report is corrected by the next). Parent updates the row +
`setState({ ...collections, rev: rev + 1 })`, which is what makes dashboards live.
Timer lost to hibernation? The next write re-arms it; absolute counts make missed
windows harmless. Report failure never fails a write (analytics rule).

**Erase** (`DbAgent.destroy()`): iterate the `collections` table → for each,
`DbCollection` stub `.destroy()` (child: `deleteAll` → `deleteAlarm` → deferred
`ctx.abort()`, copied verbatim from auth). Only when EVERY child succeeded: wipe self
(same deleteAll/deleteAlarm/deferred-abort). Any child failure → throw, so the console
fan-out surfaces its existing warning/207 and the erase endpoint can be re-called by id
(the parent registry survives precisely so a retry can still find the children —
nothing may leave orphaned DOs holding user data, contract rule 6). Demo TTL: parent
`onStart` schedules `expireDemoProject` via `this.schedule(hours*3600, ...,
{ idempotent: true })` with the `isEphemeral` re-check before destroying — auth's
pattern verbatim. Children need no alarms at all (no orphan-alarm class of bug there).

### B.8 State, analytics, demo caps

```ts
interface DbAgentState {
	projectId: string;
	provisionedAt: string | null;
	allowedOrigins: string[];
	collections: { name: string; readAccess: Access; writeAccess: Access; docs: number }[]; // cap 100
	totalDocs: number;
	rev: number; // bumped on any reported change; dashboards refetch on it
	lastEventAt: string | null;
	events: DbActivityEvent[]; // MAX_EVENTS = 50, like auth
}
// DbActivityEvent.type: 'project.provisioned' | 'collection.created' | 'collection.deleted'
//   | 'collection.configured' | 'documents.changed' (coalesced count message)
```

Analytics: `DB_EVENTS` Analytics Engine binding, dataset `cloudflarebase_db_events`
(+`_local`/`_test`/`_preview`). Writes from BOTH classes (children write doc events
directly — best-effort, wrapped, never fails an operation): blobs
`[eventType, collection, country, subjectId, 'none']`, index `projectId`. Event types:
`project.provisioned`, `collection.created`, `collection.deleted`, `doc.created`,
`doc.updated`, `doc.deleted`, `query.executed`, `subscription.opened`,
`subscription.closed`. `LOCAL_ANALYTICS` D1 mirror (table `db_events`) in local/test,
created idempotently in `DbAgent.onStart` like auth does. No SQL-read analytics
surface in v1 (non-goal) — so no `CF_ACCOUNT_ID`/`CF_ANALYTICS_API_TOKEN`/`WAE_DATASET`
vars on this worker.

Demo caps (`demo-<20hex>` + `DEMO_MODE=true`, both halves — `isEphemeral` logic copied
from auth; enforcement point in brackets):

| Cap                                     | Value                                    | Enforced                                                                          |
| --------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------- |
| `DEMO_MAX_COLLECTIONS`                  | 5                                        | parent, at register/auto-create (429)                                             |
| `DEMO_MAX_DOCS_PER_COLLECTION`          | 200                                      | child, at create (429) — bounds the project at 5×200 without cross-shard counting |
| `DEMO_MAX_DOC_BYTES`                    | 8 KB (JSON-serialized `data`)            | child, all writes (413)                                                           |
| `DEMO_MAX_SUBSCRIPTIONS_PER_CONNECTION` | 5                                        | child, at subscribe                                                               |
| `DEMO_TTL_HOURS`                        | 720 (env, `.catch(24)` schema like auth) | parent schedule → destroy fan-out                                                 |

Always-on sanity limits (all deployments): `MAX_DOC_BYTES = 128 KB`,
`MAX_SUBSCRIPTIONS_PER_CONNECTION = 10`, query `limit <= 200`, collection name
`/^[a-z][a-z0-9_-]{0,63}$/`, `MAX_COLLECTIONS = 200` per project.

### B.9 `agents/db/wrangler.jsonc` environment matrix

Top level = self-hosted default (deployable by a fork; `deploy:all` deploys auth →
db → web, so the `auth-agent` service target exists by the time db deploys). Wrangler
does not inherit top-level config into environments — every block repeats everything.
All blocks: `workers_dev: false`, `preview_urls: false`, no routes (service-binding-only
worker), `observability` + `upload_source_maps` like auth, compatibility date/flags
`2026-07-10` + `["nodejs_compat", "nodejs_als"]`.

| Block          | name                                        | DO bindings               | migrations                                               | AUTH_AGENT service                                                       | DB_EVENTS dataset                  | vars                                                                                                                                                                  | extras                                        |
| -------------- | ------------------------------------------- | ------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| top            | `db-agent`                                  | `DbAgent`, `DbCollection` | fresh `v1` `new_sqlite_classes: [DbAgent, DbCollection]` | `auth-agent`                                                             | `cloudflarebase_db_events`         | `TRUSTED_ORIGINS:""`, `SENTRY_DSN:""`, `SENTRY_ENV:"production"`                                                                                                      | `secrets.required: []`                        |
| env.production | `db-agent` (pinned for the service binding) | same                      | same                                                     | `auth-agent`                                                             | `cloudflarebase_db_events`         | + `DEMO_MODE:"true"`, `DEMO_TTL_HOURS:"720"`, `TRUSTED_ORIGINS:"https://cloudflarebase.com"`, real `SENTRY_DSN` (create in Sentry — manual op step; empty until then) |                                               |
| env.local      | `db-agent-local`                            | same                      | same                                                     | `auth-agent-local` (dev registry resolves the co-running `wrangler dev`) | `cloudflarebase_db_events_local`   | `DEMO_MODE:"true"`, `DEMO_TTL_HOURS:"720"`, `TRUSTED_ORIGINS:"http://localhost:5173,http://127.0.0.1:5173,http://localhost:8789"`                                     | `LOCAL_ANALYTICS` D1 (fixed uuid like auth's) |
| env.test       | `db-agent-test`                             | same                      | same                                                     | `auth-agent-test`                                                        | `cloudflarebase_db_events_test`    | `TRUSTED_ORIGINS:"http://localhost:8797,http://127.0.0.1:8797"` — NO `DEMO_MODE` (mirrors auth's env.test reasoning: web sets it, agent does not)                     | `LOCAL_ANALYTICS` D1                          |
| env.preview    | `db-agent-preview`                          | same                      | same                                                     | `auth-agent-preview`                                                     | `cloudflarebase_db_events_preview` | `DEMO_MODE:"true"`, `DEMO_TTL_HOURS:"720"`, `TRUSTED_ORIGINS:"https://preview-cloudflarebase-com.cloudflarebase.workers.dev"`, preview `SENTRY_DSN`                   |                                               |

package.json scripts (mirroring auth): `dev` = `wrangler dev --env local
--persist-to=../../.wrangler/state/ --ip 0.0.0.0 --port 8789`; `dev:test` =
`wrangler dev --env test --ip 127.0.0.1 --port 8799 --persist-to
../../.wrangler/test-state/db-agent`; `migrations`, `build`, `typecheck` (once!),
`cf-typegen`, `deploy`, `deploy:production`, plus `test:unit` = `node --import tsx
--test src/*.unit.test.ts`.

`template/wrangler-fragment.jsonc`: fresh `v1` migration with BOTH classes, both DO
bindings, `DB_EVENTS` dataset, `vars.TRUSTED_ORIGINS`/`SENTRY_DSN`, commented note that
`AUTH_AGENT` is only needed for multi-worker installs (single-worker consumers get the
`AuthAgent` namespace by having added auth — §B.6). `template/worker-entry.ts`:
re-exports `DbAgent`, `DbCollection`, `default` + the `AssertDbAgentEnv` assert lines,
with the class-only variant documented in a comment for entrypoints that already have a
default export.

`src/bindings.ts`: `DbAgentBindings` — required `DbAgent`, `DbCollection` (both
`AnyDurableObjectNamespace` with auth's documented `any` rationale), `DB_EVENTS`;
optional `AUTH_AGENT?: Fetcher`, `AuthAgent?`, `TRUSTED_ORIGINS?`, `SENTRY_DSN?`,
`SENTRY_ENV?`, `LOCAL_ANALYTICS?`, `DEMO_MODE?: 'true'`, `DEMO_TTL_HOURS?`.
`src/bindings.test-d.ts` locks it with `@ts-expect-error` negatives (missing
`DbCollection`, mistyped `DB_EVENTS`, etc.), excluded from the build tsconfig.

### B.10 Phase B verification

- `agents/db`: `npx tsc --noEmit` (runs bindings.test-d.ts), `npm run test:unit`
  (query compiler/matcher parity: same fixture docs through SQL-compile-against-
  better-sqlite? NO — no native deps: parity tests run matcher-vs-matcher plus
  compiler snapshot tests asserting exact SQL + bound params; the SQL-vs-JS behavioral
  parity is then pinned end-to-end by the e2e live-query spec in Phase D)
- `npm run migrations` generates cleanly; `src/migrations.ts` inlined
- `npx wrangler types`; `npm run build`; `npm pack --dry-run` shows dist/template/
  NOTICE/cloudflarebase.agent.json only
- Manual: `npm run dev` (from `agents/db`, :8789) + auth dev on :8788; curl
  `POST /agents/db-agent/dev1/collections/todos/documents` (expect 401 auth-mode),
  configure public via `PUT .../admin/collections/todos` guard-free direct, CRUD +
  query round trip; `wscat`/node WebSocket subscribe → snapshot → REST write → change
  frame; kill the dev process mid-subscription, restart, confirm resubscribe works
- Root `npm run lint` (ESLint config gains `agents/db/dist/` ignore, mirroring auth's)

---

## Phase C — web integration

### C.1 Bindings and config (the five-block checklist)

- `wrangler.jsonc` — add `{ "binding": "DB_AGENT", "service": ... }` to ALL FIVE
  blocks: top → `db-agent`; `env.local` → `db-agent-local`; `env.test` →
  `db-agent-test`; `env.production` → `db-agent`; `env.preview` → `db-agent-preview`.
- `wrangler.e2e.jsonc` — `DB_AGENT` → `db-agent-test`.
- `src/app.d.ts` — `Platform.env` gains `DB_AGENT: Fetcher` beside `AUTH_AGENT`.
- `npm run cf-typegen` afterwards (never hand-edit `worker-configuration.d.ts`).
- root `package.json` — `deploy:all` becomes
  `npm --prefix agents/auth run deploy && npm --prefix agents/db run deploy && npm run deploy`
  (auth first: db's AUTH_AGENT binding needs it; web last).
- `scripts/local-dev.json` — add `{ "name": "db-agent", "command": "npm run dev --prefix ./agents/db" }`
  and change web's wait to `wait-on tcp:localhost:8788 tcp:localhost:8789 && vite dev ...`.
- `scripts/postinstall.json` — add `cd ./agents/db && npm install`.
- `playwright.config.ts` — third webServer entry:
  `node scripts/kill-port.mjs 8799 && node scripts/clean-dir.mjs .wrangler/test-state/db-agent && npm run dev:test --prefix agents/db`,
  url `http://localhost:8799/health` (skipped when `BASE_URL` is set, like the others).
  Note `scripts/clean-dir.mjs` only accepts `.wrangler/test-state` targets — the new
  path qualifies; no script change needed.

### C.2 Registry + guard + proxies (one registry entry, mostly free)

- `src/lib/agents/manifests/db.json` — copy of the package manifest.
- `src/lib/agents/registry.ts` — add the `db` entry (`binding: 'DB_AGENT'`,
  `devHost: 'localhost:8789'`). Phase A machinery then automatically: opens
  `/agents/db-agent/<id>/collections/*` + `/config` and keeps `/overview`, `/admin/*`,
  root WS operator; dispatches `/agents/db-agent/*` over `DB_AGENT`; includes db in the
  delete fan-out; adds the sidebar entry.
- Proxy routes (all use the Phase A generic helpers; `cf-ipcountry` forwarded;
  `fetch(url, init)` never a Node Request; `toNativeResponse` on the way out):
  - `src/routes/api/projects/[projectId]/db/collections/[...path]/+server.ts` —
    public passthrough (GET/POST/PUT/PATCH/DELETE/OPTIONS) to
    `/agents/db-agent/<id>/collections/<path>`; forwards `Authorization`. (WS subscribe
    does NOT go through here — browsers hit `/agents/...` directly, exactly like auth's
    AgentClient path.)
  - `src/routes/api/projects/[projectId]/db/overview/+server.ts` — GET operator.
  - `src/routes/api/projects/[projectId]/db/admin/[...path]/+server.ts` — operator
    passthrough for `PUT/DELETE /admin/collections/...`, `POST /admin/query`,
    `PUT /admin/settings`.

### C.3 Dashboard Database tab

- `src/routes/(app)/dashboard/[projectId]/db/+page.server.ts` — loads
  `/overview` over the DB_AGENT binding (assertProjectId + agentUrl + typed via the
  zod mirror `dbOverviewSchema`).
- `src/routes/(app)/dashboard/[projectId]/db/+page.svelte` — mirrors the auth tab
  architecture: `data-hydrated` gate, tabs, AgentClient realtime (`agent: 'db-agent'`,
  dev host `localhost:8789`) + 5 s polling fallback; refetches the browsed collection
  via `POST /api/projects/<id>/db/admin/query` whenever `state.rev` changes. Tabs:
  1. **Collections** — table of collections (name, modes, live doc count,
     `data-testid="db-collections-table"`); create-collection form
     (`db-create-collection`); selecting one opens the browser: query controls
     (field/op/value rows + orderBy + limit → DbQuery), document table
     (`db-documents-table`), JSON editor dialog for create/edit (admin PUT), delete
     buttons (admin DELETE).
  2. **Access** — per-collection read/write mode selects (`db-access-modes`) +
     allowed origins textarea (admin settings), mirroring the auth Settings card.
  3. **Integration** — copyable snippets (`db-integration`): REST curl (with
     `Authorization: Bearer` from auth `/token`), `@cloudflarebase/db/client` usage,
     and a raw WebSocket subscribe example, all addressed to the project's real URLs.
     Live activity feed from `state.events` (`db-activity`).
- Overview page `+page.svelte`: add the `product-db` card (counts from a lightweight
  `/db/overview` fetch or the layout's registry data), drop Database from `comingSoon`.
- Sidebar: appears automatically from the manifest (`nav-db`).

### C.4 OpenAPI db module

`src/lib/openapi/db.ts` — the **Database** tag; registers the `src/lib/agents.ts` db
mirrors (`DbQuery`, `DbDocument`, `DbQueryResult`, `DbWriteRequest`,
`DbCollectionConfig`, `DbOverview`, subscription frame schemas) and contributes paths
under the project base: `/db/collections/{collection}/documents` (POST),
`/db/collections/{collection}/documents/{docId}` (GET/PUT/PATCH/DELETE),
`/db/collections/{collection}/query` (POST), `/db/config` (GET), plus operator paths
`/db/overview`, `/db/admin/collections/{name}` (PUT/DELETE), `/db/admin/query` (POST).
Security: `bearerAuth` (project JWT from `/auth/token`) on the public paths;
`sessionCookie` on operator paths. The tag description documents the live-query
WebSocket endpoint + frame flow and points at the registered frame component schemas
(WS has no OpenAPI path construct — this is the documented home, per the locked zod
decision). Composer in `index.ts` gains one import.

### C.5 Phase C verification

- `npm run check`, `npm run lint`, `npm run cf-typegen` diff sane
- `npm test` — existing suite green (guard spec still passes: db operator routes 401
  via the default-operator rule even before Phase D adds explicit assertions)
- Manual `npm run dev` (now boots three processes): create a project → Database tab →
  create collection → add docs in the browser → second browser window sees the doc
  count move without reload (state sync) → set collection public → curl CRUD from a
  terminal → auth-mode collection rejects curl without a token and accepts one minted
  by `GET /api/projects/<id>/auth/token`
- Delete the project → both agents erased (watch for the 207 warning absence)

---

## Phase D — client SDK, CLI, e2e, CI, docs

### D.1 Thin client SDK (`@cloudflarebase/db/client`)

- `agents/db/src/client.ts` — isomorphic (browser + Node >= 22 native WebSocket), zero
  Workers imports; `tsconfig.build.json` emits it; package.json `exports` gains
  `"./client": { "types": "./dist/client.d.ts", "default": "./dist/client.js" }`.
- Reuses the SAME zod schemas from `./schemas` (same package — the copy rule does not
  apply inside one project): responses parsed with `dbDocumentSchema`/
  `dbQueryResultSchema`; inbound WS frames parsed with the server-frame union;
  outbound frames built from the client-frame schemas.
- API:

```ts
const db = createDbClient({
	baseUrl: 'https://console.example.com/api/projects/my-app/db', // or the /agents/db-agent/<id> URL
	getToken?: () => Promise<string | null>,   // e.g. fetch('/api/projects/my-app/auth/token')
});
const todos = db.collection('todos');
await todos.create({ data }, { id? });  await todos.get(id);
await todos.update(id, data);  await todos.patch(id, partial);  await todos.delete(id);
await todos.query({ where, orderBy, limit, cursor });          // → { docs, nextCursor? }
const unsubscribe = todos.subscribe(query, {
	onSnapshot(docs) {}, onChange(change) {}, onError(err) {},
});
```

- `subscribe` derives the WS URL (`http(s)` → `ws(s)` + `/subscribe` — for the proxy
  base it rewrites to the `/agents/db-agent/<id>/collections/<c>/subscribe` direct
  path), sends the token in the subscribe frame, maintains local doc order with the
  shared order comparator, and reconnects with exponential backoff + full resubscribe
  (fresh snapshot) per §B.5 semantics. One socket per collection, subscriptions
  multiplexed by `id`.

### D.2 CLI: manifest reading + the second-agent entrypoint fix

- `cli/src/lib/manifest.ts` (new) — the copied zod manifest schema;
  `readManifest(projectDir, packageName)` from
  `node_modules/<pkg>/cloudflarebase.agent.json`; refuses unknown `manifestVersion`
  with a friendly UserError ("upgrade the CLI").
- `cli/src/lib/agents.ts` — registry shrinks to
  `{ auth: { packageName, description }, db: { packageName:
'@cloudflarebase/db', description: 'Firestore-style documents with live queries -
one Durable Object per collection' } }`. `exportLine` is DELETED from `AgentSpec`;
  it is now DERIVED from the manifest: classes from `durableObjects[].class`, assert
  type from `entrypoint.assertEnvType`, producing
  - full variant: `export { DbAgent, DbCollection, default } from '@cloudflarebase/db';`
    - assert import/type lines
  - class-only variant: same without `, default`.
    `CLOUDFLAREBASE_DB_SPEC` override works untouched (generic `<AGENT>` code).
- `cli/src/lib/entrypoint.ts` — **the known blocker fix**: when the target file already
  has a default export, no longer throw. New behavior: if the existing default came
  from a cloudflarebase agent (the file contains `@cloudflarebase/`), prepend the
  CLASS-ONLY export line — `routeAgentRequest` inside the already-exported default
  handler resolves ANY DO binding in `env` by kebab-cased name, so auth's default
  fetch handler routes `/agents/db-agent/...` to `DbAgent` with zero extra wiring.
  Only a NON-cloudflarebase default export still gets the current UserError hint
  (routing from a user's own fetch handler is a decision, not a patch). Idempotence
  rule unchanged (package name presence = already wired).
- `cli/src/commands/add.ts` — validate the manifest right after `npm install` (before
  any file edits), pass the derived export lines to `patchEntrypoint`. Fragment merge
  is untouched — `readFragment` + `mergeWranglerConfig` already append DO bindings by
  name and migrations by missing class, so the two-class db fragment merges cleanly
  after auth (verify with a unit-style manual run in D.6). The fragment stays a
  separate authored file (its comments are the consumer's documentation; the
  manifest's `bindings` block is the machine-readable summary for the console —
  generating one from the other is a non-goal).
- `cli/src/commands/init.ts` — no change needed (it delegates to `add`), verify only.

### D.3 e2e specs (what each pins)

New helpers in `e2e/helpers.ts`: `dbCollectionsPath`, `dbDocumentsPath`, `dbQueryPath`,
`dbAdminPath`, `dbPage`, `DB_PROJECT = 'e2e-db'` (own project id — SEED_PROJECT counts
are asserted exactly and must not move).

| Spec                                     | Pins                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e/db.api.spec.ts`                     | operator creates collections in the three modes on `DB_PROJECT`; public-mode unauthenticated CRUD + query round trip; auth-mode: 401 without token → sign-up on `DB_PROJECT` via auth REST → `GET /token` → Bearer CRUD works; owner-mode: two users each see only their own docs, cross-user update → 403/404; doc size cap 413; unknown collection auto-create honors default `auth` modes; cursor pagination pages exactly                                                                                    |
| `e2e/db-live.api.spec.ts`                | Node's native WebSocket (Node >= 22) against `ws://localhost:8797/agents/db-agent/...` (through the built web worker — proves the WS passthrough) AND direct `:8799`; subscribe → exact `snapshot`; REST create/update/delete → `added`/`modified`/`removed` frames; windowed query (orderBy+limit 2): inserting a doc that displaces another yields `added` + `removed` for the displaced one; unsubscribe ack; invalid query → `error invalid-query`; auth-mode subscribe without token → `error unauthorized` |
| `e2e/db-agent-direct.api.spec.ts`        | AGENT_URL (`http://localhost:8799`), skipped when `BASE_URL` set: `/health` = `{service:'db-agent',status:'ok'}`; 404 unknown route; 400s — invalid project id, invalid collection name, malformed query, oversized doc; `/internal/projects/...` reachable directly here (documents that the production guard is the LACK of a public route, mirroring the auth direct spec's role)                                                                                                                             |
| `e2e/console-guard.api.spec.ts` (extend) | `/agents/db-agent/<SEED>/overview` → 401; `/agents/db-agent/<SEED>/admin/collections/x` PUT → 401; `/api/projects/<SEED>/db/admin/query` → 401; `/api/projects/<SEED>/db/overview` → 401; public db surface does NOT 401 (a mode denial is 401-from-agent with a JSON body distinct from the guard's — assert on the body's error string to disambiguate, or use a public-mode collection seeded by the operator project first)                                                                                  |
| `e2e/demo-project.api.spec.ts` (extend)  | the Integration-tab db story works unauthenticated on a demo project: guard lets `demo-<hex>` through the operator surface → create a public collection → CRUD + query + one live subscribe round trip; demo caps: collection #6 → 429, doc #201 → 429                                                                                                                                                                                                                                                           |
| `e2e/db.ui.spec.ts`                      | `gotoDbPage()` waits `data-hydrated`; collections table renders; create collection → appears without reload; create doc via editor → row appears; access-mode change persists; integration snippets present (`db-integration`)                                                                                                                                                                                                                                                                                   |
| `e2e/openapi.api.spec.ts` (extend)       | Database tag present; `/db/collections/{collection}/query` + documents paths listed; `DbQuery` in components.schemas                                                                                                                                                                                                                                                                                                                                                                                             |
| `e2e/dashboard.ui.spec.ts` (extend)      | sidebar `nav-db` navigates; overview `product-db` card renders                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Seeding: db specs are self-seeding (idempotent creates on `DB_PROJECT` /
`SCRATCH_PROJECT`) rather than touching `seed.setup.ts`, keeping SEED_PROJECT's exact
counts untouched. All API contexts already send `Origin` (project-level config).

### D.4 CI / workflows / publishing

- `.github/workflows/db-agent-deploy-prod.yaml` + `db-agent-deploy-preview.yaml` —
  copies of the auth pair with `workingDirectory: agents/db`, path filters
  `agents/db/**` (+ `src/lib/**` on prod, mirroring auth), environments
  `production`/`preview` (same GitHub-environment secret rule; no repository secrets).
- `.github/workflows/release.yaml` — add the tag trigger `db-v*.*.*` and the case arm
  `db-v*) dir=agents/db`. One-time op note: configure the npm Trusted Publisher for
  `@cloudflarebase/db` (or publish 0.1.0 locally first, then wire OIDC); provenance
  still requires the repo to be public before tagging.
- `.github/workflows/quality.yaml` — add "Typecheck the db agent" (`npx tsc --noEmit`,
  `working-directory: agents/db`) and "Unit-test the db agent" (`npm run test:unit`).
  Root postinstall now installs `agents/db` too, so no extra install step.
- `.github/workflows/e2e.yaml` — unchanged (playwright config boots the db worker).

### D.5 Documentation

- `agents/db/CLAUDE.md` (new) — mirrors auth's structure: key files, the two-DO
  topology + per-collection ceilings (10 GB / ~1k req/s / no read replicas — push
  live queries are the mitigation), HTTP/RPC surface, hibernation + subscription
  survival design, JWT verification + JWKS fallbacks, registry-consistency story
  (push + lazy pull + erase-keeps-registry-until-children-die), demo caps table,
  publishing constraints (never ship worker-configuration.d.ts / env.d.ts; fresh-v1
  fragment warning covers BOTH classes), unit-test commands.
- root `CLAUDE.md` — repository-layout table row for `agents/db`; commands table
  (db dev/migrations/typegen/build/test:unit); architecture decisions: manifest
  (what it drives: guard, proxies, sidebar, fan-out, OpenAPI, CLI), collection-per-DO
  rationale, db ports; e2e section (three webServers, db spec conventions); gotchas
  (run wrangler from `agents/db`; deploy order auth → db → web because of the
  AUTH_AGENT binding).
- `agents/auth/CLAUDE.md` — delta: ships `cloudflarebase.agent.json`, kept in sync
  with `src/lib/agents/manifests/auth.json`; exportLine now CLI-derived.
- `docs/agent-contract.md` — flip the "not implemented yet" banner: implemented as of
  this work; record the deltas (manifestVersion, `proxy`, `entrypoint`,
  `perCollection` scope, `${prefix}` dropped).
- `agents/db/README.md` — consumer-facing: install via CLI, limits, client SDK usage.

### D.6 Phase D verification

- `cli`: `npm run typecheck`, `npm run build`; manual: scaffold a temp Worker dir,
  `CLOUDFLAREBASE_AUTH_SPEC=<packed tgz> add auth` then
  `CLOUDFLAREBASE_DB_SPEC=<packed tgz> add db` — the previously-failing second add
  now prepends the class-only line; `wrangler.jsonc` shows both classes appended under
  the next migration tag; re-run both adds → "already configured/wired" (idempotence)
- `npm test` — full suite including every new spec; then `npm run test:e2e:ui` spot
  checks on the live-query spec
- `npm run check` + `npm run lint` at root; `npx tsc --noEmit` in agents/auth,
  agents/db; `npm run typecheck` in cli
- Manual `npm run dev` end-to-end demo-flow walkthrough (demo project → Database tab →
  public collection → snippet curl → live update visible)

---

## Non-goals for v1 (explicit)

- **No cross-collection operations**: no batches, no transactions, no joins — shard
  independence is the architecture; any cross-collection primitive reintroduces
  coordination between sibling DOs.
- **No secondary/compound field indexes** (queries scan the collection shard;
  documented) and no generated columns.
- **No cross-type ordering/comparison guarantees** in the query DSL (same-type only).
- **No `newIndex`/`oldIndex` in change frames**; the SDK re-sorts locally.
- **No resume tokens / missed-event replay** on reconnect — fresh snapshot semantics.
- **No read-analytics surface** on the db agent (no /analytics, no WAE SQL reads) and
  **no AI chat**; the copilot pane stays auth-grounded.
- **No fleet-page db integration** beyond nothing at all: no `/fleet` on the db
  worker, no `getFleetCounts` — `/admin` stays auth-only in v1.
- **No outbound email** from the db agent (no EMAIL binding).
- **No per-project agent enable/disable UI**; `project_agent` rows are groundwork,
  the sidebar reads the static registry, deletion always fans out to every agent.
- **No document-level rules language** (only the three collection modes) and no
  field-level validation of `data`.
- **No `${prefix}` manifest templating**; datasets are concrete self-hosted defaults.
- **No fragment generation from the manifest**; the fragment stays authored.

## Open risks

1. **SQL-vs-JS matcher parity** is the correctness linchpin (snapshot via SQL, deltas
   via JS). Mitigations: single parsed Query source, unit fixtures over the matcher +
   SQL snapshot tests, e2e live spec exercising both paths on the same data. Residual
   risk: SQLite affinity corner cases (mixed-type fields) — bounded by documenting
   cross-type behavior as unspecified.
2. **Windowed-subscription re-query cost**: a hot collection with many windowed
   subscribers pays one query per write per subscriber. Bounded by per-connection caps
   and per-collection sharding; if it bites, add a sorted-membership incremental
   update later (no protocol change needed).
3. **Coordinator/child config drift**: modes cached in the child could go stale if a
   config push fails AND the lazy pull never triggers (child already has old meta).
   Mitigation: parent re-pushes on every settings write with retry-once; a
   `configVersion` integer in the pushed config lets the child detect regressions.
   Accepted residual: seconds-level staleness after a failed push until the next push.
4. **`agents` SDK evolution**: `DbCollection` deliberately bypasses the SDK, so SDK
   upgrades affect only `DbAgent`; the raw hibernation API is a stable platform
   surface. Inverse risk: two socket stacks to maintain — accepted for the isolation
   reasons in §0.1.
5. **`jose` supply chain**: new runtime dependency; pinned caret range, provenance via
   npm audit signatures in the release flow (same posture as other deps).
6. **Erase fan-out scale**: destroy iterates up to MAX_COLLECTIONS=200 children
   sequentially; worst case ~200 RPCs in one request. Acceptable at v1 caps; batch
   with Promise.allSettled in chunks of 10 if needed.
7. **Sentry DSNs for prod/preview** need creating in Sentry before the deploy
   workflows go live (empty string disables reporting until then — safe default).
8. **npm Trusted Publisher setup** for `@cloudflarebase/db` is manual and may require
   a first local publish (documented in release.yaml comments).

## Verification matrix (roll-up)

| Phase | Commands                                                                                                            | Manual                                                              |
| ----- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| A     | `npm run check` · `npm run lint` · `agents/auth: npx tsc --noEmit` · `npm test` (zero spec edits)                   | dev walkthrough: auth tab, sidebar, project delete                  |
| B     | `agents/db: npx tsc --noEmit` · `npm run test:unit` · `npm run migrations` · `npm run build` · `npm pack --dry-run` | :8789 curl CRUD/query, WS subscribe round trip, restart-resubscribe |
| C     | `npm run check` · `npm run lint` · `npm run cf-typegen` · `npm test`                                                | three-process `npm run dev`, Database tab end-to-end, erase fan-out |
| D     | full: root check/lint/test + both agents `tsc --noEmit` + db `test:unit` + cli `typecheck`                          | CLI double-add on packed tarballs; demo-flow walkthrough            |

## Key existing files touched (quick index)

- `src/hooks.server.ts` — guard + dispatch (A)
- `src/lib/server/registry.ts`, `src/lib/server/db/{schema,index}.ts` — fan-out + project_agent (A)
- `src/lib/server/auth-agent.ts` → `src/lib/server/agents.ts` (A)
- `src/lib/openapi.ts` → `src/lib/openapi/{index,auth,db}.ts` (A, C)
- `src/lib/agents.ts` — db zod mirrors (C)
- `src/routes/(app)/dashboard/[projectId]/{+layout.svelte,+page.svelte}` (A, C) + new `db/` pages (C)
- `wrangler.jsonc` (5 blocks) · `wrangler.e2e.jsonc` · `src/app.d.ts` · `package.json` ·
  `scripts/{local-dev,postinstall}.json` · `playwright.config.ts` (C)
- `agents/auth/{cloudflarebase.agent.json,package.json}` (A)
- `agents/db/**` — new package (B)
- `cli/src/lib/{agents,entrypoint,manifest}.ts`, `cli/src/commands/add.ts` (D)
- `e2e/*` new + extended specs (D)
- `.github/workflows/{release,quality,db-agent-deploy-prod,db-agent-deploy-preview}.yaml` (D)
