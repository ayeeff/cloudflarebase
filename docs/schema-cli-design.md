# Schema CLI: `cloudflarebase schema` + console auth

Status: IMPLEMENTED (drafted 2026-08-06, approved and built same day)

> **Deviations and specifics from the draft, for future readers:**
>
> - **Console side**: `getConsoleSession` forwards the `Authorization` header
>   alongside cookies (`src/lib/server/console.ts` + `hooks.server.ts`), so a
>   bearer session token passes the console guard on every operator surface.
>   The hand-off page is `/cli-auth` (operator-only via `classifyAccess`, so
>   signed-out operators bounce through `/login` - hard bounce even in demo
>   mode, where the guard's bare-/dashboard exception is scoped to exactly
>   that entry). `POST /api/cli/token` returns the caller's own session
>   cookie value (`__Secure-` prefix handled) with a belt-and-braces
>   same-origin check; the page form-POSTs token+code to the CLI's
>   `127.0.0.1:<port>` listener - a top-level navigation, so the listener
>   never speaks CORS.
> - **CLI side**: `login [origin]` (browser hand-off with a one-time code and
>   5-minute timeout, `--email`/`--password` fallback driving the public
>   console sign-in and storing the `set-auth-token` header), `logout`,
>   `schema generate` (drizzle `schema.ts` from declared columns; `--dsl`
>   writes `cloudflarebase.schema.jsonc` from declared state), `schema
apply` (DSL file -> `PUT /db/admin/tables/:name` per table; the agent's
>   additive-only `planDdl` is the safety), and `schema drop <table>` (typed
>   confirmation, `--yes` for CI). All take `--project` and `--branch`; a
>   branch is pure id composition (`<project>--<branch>`), exactly as
>   designed. Config lives in `~/.cloudflarebase/config.json`.
> - **Pinned by** `e2e/cli-auth.api.spec.ts` (token endpoint, bearer flow,
>   anonymous/cross-origin refusals) and `e2e/cli-auth.ui.spec.ts` (the
>   approve hand-off against a real localhost listener).

The missing half of the T2 ORM story. `@cloudflarebase/db/drizzle` executes
queries, but the consumer still hand-writes the drizzle schema that the
column DSL already declares - two copies, free to drift. This adds the
wrangler/supabase-style workflow: **`schema generate` / `schema apply` /
`schema drop`, with `--branch` targeting**, plus the console auth the CLI
has needed for any operator surface.

## Commands

```
cloudflarebase login [origin]        authenticate against a console
cloudflarebase logout                revoke + forget the stored token
cloudflarebase schema generate      declared columns -> drizzle schema.ts
cloudflarebase schema apply         local DSL file -> PUT /admin/tables/:name
cloudflarebase schema drop <table>  delete a table (typed confirmation, --yes for CI)
```

Every `schema` command takes `--project <id>` and `--branch <name>`. A
branch IS `<project>--<branch>` (docs/branches-design.md), so `--branch` is
pure id composition - zero backend work - and the PlanetScale loop falls
out: `schema apply --branch staging`, test against the staging branch,
`schema apply` to main.

## Console auth (the actual blocker, and deliberately small)

The agent already accepts `Authorization: Bearer <session token>` - that is
the documented external-client path on every project instance, and the
console is the same agent under project id `console`. Missing pieces:

1. **Guard**: `getConsoleSession` forwards only cookies; also forward the
   `Authorization` header to `/api/auth/get-session`. One signature change
   in `src/lib/server/console.ts` + `hooks.server.ts`. No agent release.
2. **`cloudflarebase login`**: wrangler-style browser hand-off. The CLI
   listens on a localhost port with a nonce, opens
   `<origin>/cli-auth?port=N&code=<nonce>`. That page is a new operator
   page (one line in `classifyAccess`; signed-out operators bounce through
   `/login` for free, social sign-in included). On "Approve", the page asks
   `POST /api/cli/token` (operator-only by guard default) for the caller's
   session token and hands it to the localhost listener with the nonce.
   The CLI stores `{ origin, token }` in `~/.cloudflarebase/config.json`.
3. **Non-interactive fallback** for CI: `login --email --password` drives
   the public console sign-in surface directly and stores the
   `set-auth-token` response header. Social-only operators use the browser
   flow.

The CLI therefore holds an ordinary operator session: visible in the
console's sessions table, revocable there, expiring like any other.
`logout` calls sign-out with the bearer token and deletes the local file.
No new token store, no PAT table, no agent changes.

## The schema file

`cloudflarebase.schema.jsonc` - the column DSL verbatim, one entry per
table, exactly the `PUT /admin/tables/:name` body (jsonc-parser, comments
survive - the `add` command's existing regime):

```jsonc
{
	"tables": {
		"todos": {
			"readAccess": "auth",
			"writeAccess": "owner",
			"columns": [
				{ "name": "title", "type": "text", "maxLength": 200 },
				{ "name": "done", "type": "boolean", "default": false }
			]
		}
	}
}
```

- **`apply`** upserts each table through the admin surface. Safety is the
  agent's existing contract, not new CLI logic: `planDdl` is additive-only,
  destructive diffs answer 400 before anything is pushed, child DDL
  failures roll back and answer 409. The CLI reports per table and exits
  non-zero on any refusal. Destructive changes stay deliberate:
  `schema drop` + re-`apply`.
- **`generate`** reads the declared configs over the admin surface and
  emits a drizzle `schema.ts` (system columns `id`/`owner`/`created_at`/
  `updated_at` included, row types exported) for the sqlite-proxy adapter.
  Prisma models later. `generate --dsl` also writes
  `cloudflarebase.schema.jsonc` from declared state - the adopt-an-existing-
  project path.

## What stays true

- The column DSL remains the single schema source of truth. The SQL
  endpoint keeps refusing DDL; `apply` speaks the DSL, never SQL.
- Registry names stay unique across kinds; the agent's 409s surface as-is.
- Demo projects: admin routes are operator-only regardless, and demo ids
  never reach `--branch` (branch minting already refuses them).

## Out of scope (v1)

- `schema diff` as its own command (`apply` already fails loudly on
  destructive diffs; a dry-run flag can ride the same PUT-less path later).
- Prisma model emission, collection validator typegen.
- PAT-style long-lived tokens; revisit only if session-lifetime CLI auth
  proves annoying in CI.
