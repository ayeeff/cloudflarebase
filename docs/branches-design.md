# Project branches

Status: IMPLEMENTED, control plane (drafted 2026-08-05; approved and built
2026-08-05 - the dashboard switcher and overview grouping are pending a
design-variant pick)

> **Deviations and specifics from the draft, for future readers:**
>
> - **Routes**: `POST` + `GET /api/projects/:id/branches` (the GET is the
>   switcher's data source), operator-only via the console guard's default.
>   Deleting a branch IS `DELETE /api/registry/projects/<root>--<branch>`,
>   as designed.
> - **Refusal contract** (pinned by `e2e/branches.api.spec.ts`): unknown
>   root 404; branch-of-branch, `main` (it would alias the bare id), demo
>   roots, malformed names, and a combined id past the 32-char ceiling all
>   400; duplicate branch 409. The `MAX_PROJECTS` installation ceiling
>   counts branches - a branch is a full row.
> - **A branch row's display name** is `<root name> (<branch>)`; the DTO
>   (`RegistryProject`, mirrored in `src/lib/agents.ts`) gained `parentId`
>   and `branchName`, null on roots.
> - **Schema shipping**: `parent_id`/`branch_name` land via the runtime
>   CREATE for fresh installs plus duplicate-column-tolerant ALTERs in
>   `src/lib/server/db/index.ts` (the control plane applies its schema at
>   runtime; no migration files exist to carry it).
> - **OpenAPI**: the per-project document gained a console-plane module
>   (`src/lib/openapi/console.ts` - not an agent module; branches are
>   minted by the registry) documenting `/branches` under the Console tag,
>   with `CreateBranchRequest`/`RegistryProject`/`ProjectBranches`
>   components.
> - The root-delete cascade deletes branch rows and runs a full per-branch
>   erase fan-out child-first, exactly as designed; erase failures are
>   reported per branch id in the delete warning.

Every project gets named **branches** (`main`, `staging`, `preview-42`, …) -
PlanetScale's mental model applied to the whole backend, not just the
schema: a branch is a **fully isolated copy of the entire platform surface**
(users, sessions, collections, tables, replicas, analytics) that every agent
operates inside, switchable from one dashboard. Firebase makes you clone
projects by hand; Supabase charges for database branching; a Cloudflarebase
branch is the whole backend - auth included - because the unit of isolation
is the agent instance, not a database.

## The design in one sentence

**A branch IS a derived project id**: `<projectId>--<branch>`, with the bare
id as `main` - and no agent changes at all, because isolation, auth,
replication, erase fan-out, demo caps, and the JWT trust boundary already
key on the project id.

## Why derived ids beat a branch field

- `projectIdSchema` is `/^[a-z0-9][a-z0-9-]{0,31}$/` in every agent TODAY:
  `myapp--staging` is already a valid instance name end to end. Zero agent
  releases, zero migration, zero new schema fields in `@cloudflarebase/auth`
  or `@cloudflarebase/db`.
- Isolation is _structural_, not policy: a branch cannot leak into another
  because nothing is shared - not a row, not a JWKS keypair, not a replica.
  `myapp--staging` JWTs cannot verify against `myapp`: different agents,
  different keys. The strongest boundary the platform has is the DO
  instance name, so branches are made of it.
- Every existing surface (OpenAPI docs, copilot, analytics, fleet view,
  replication globe) works per branch for free - they are all keyed by
  project id.
- Deleting a branch is the existing project-delete fan-out.

Naming: `--` is the separator (the only charset-legal option). Two rules at
the registry (the sole minter of project ids):

1. **User-chosen project ids may not contain `--`** (new validation at
   create; keeps parsing unambiguous). Existing ids containing `--` are
   grandfathered as plain projects - the registry decides what is a branch,
   never the string shape.
2. **Branch names**: `/^[a-z0-9][a-z0-9-]{0,15}$/`, no `--`. Combined id
   fits the 32-char ceiling; the create form enforces it with a counter.

## Control plane (the only real work)

- `project` table gains `parent_id` (null = a root project) and
  `branch_name` (null = `main`, the bare id). A branch row is a full
  registry row - guard, proxy classification, and delete fan-out already
  key on rows and need nothing.
- `POST /api/projects/:id/branches` mints `<id>--<branch>` (session-gated,
  reserved-id rules apply); `DELETE` reuses `deleteProject`. Deleting the
  root project deletes its branches first (same child-first invariant as
  the db registry).
- **Branch-from (v2)**: seed a new branch from another via the existing
  NDJSON export/import (collections, tables with ids/owners/timestamps
  preserved) plus the roles registry and collection/table configs. v1
  branches start empty, like a fresh project - the isolation is the
  feature; copying is a convenience on top.
- **Promote/merge is deliberately out of scope**: data branches do not
  merge (PlanetScale merges schema only). What promotion means here is an
  app config change - point production traffic at a different branch id -
  and that belongs to the consumer's deploy, not the platform.

## Dashboard

- Branch switcher beside the project switcher (same component pattern):
  `main` plus the root's branches. Switching swaps the `[projectId]` route
  param - every page already works.
- The projects overview groups branches under their root project instead of
  listing `myapp--staging` as a sibling of `myapp`.
- Integration snippets already print the full project id, so copied code
  targets the right branch by construction.

## What deliberately does NOT change

- Agents, packages, manifests, the CLI (`add` is per-worker, not
  per-project), wrangler configs, service bindings, the hot path, JWT/JWKS,
  replication (each branch replicates independently - staging load cannot
  pressure main's siblings), the future DbGateway (a gateway is per
  project id, so per branch, automatically).
- Demo projects: `demo-<hex>` ids never get branches (the create route
  refuses; a demo IS an ephemeral branch already).

## Costs and edges

- DO count multiplies per branch **only on use** - instances spawn lazily,
  so an idle branch costs nothing until touched.
- The 32-char id ceiling caps root + branch length; enforced at create.
- Analytics events carry the full project id, so per-branch analytics work;
  the fleet view should group by root project when the switcher lands
  (cosmetic).
