# Hosting Agent

Apps and functions on Workers for Platforms (docs/managed-service-design.md,
Phase B). One `HostingAgent` Durable Object per project orchestrates deploys;
the SAME worker serves `*.cfbase.dev` by dispatching the first host label
into the namespace - the script name IS the full subdomain, zero lookup, and
dispatch NEVER parses a subdomain into app and branch (the control plane's
claims table resolved that at deploy time).

Also read [AGENTS.md](AGENTS.md). Published as `@cloudflarebase/hosting`
(the Supabase distribution model - see `agents/auth/CLAUDE.md` for the
mechanism; `files` ships `dist`, `template`, `NOTICE`, and the manifest).

## Architecture

- **Two roles, decided by hostname** (`src/index.ts`): serving hosts (ending
  in `HOSTING_DOMAIN`) dispatch EVERY path to the user's app - our own
  surfaces exist only on non-serving hostnames, which is also what keeps
  `/internal/*` service-binding-only (this worker has no public route except
  the wildcard, `workers_dev` and `preview_urls` false everywhere).
- **The console owns claims.** The agent never derives or accepts a
  subdomain from a request: the console resolves the claim in control-plane
  D1 and pushes it over `PUT /internal/projects/:id/apps/:app` before
  forwarding a deploy. That is what makes `POST /apps/:app/deploys` safe on
  the operator surface - it can only deploy to subdomains recorded for THIS
  project. Never add a route that takes a subdomain from a caller.
- **Deploy = the three documented WfP steps** (`src/cloudflare.ts`): asset
  upload session (manifest -> wanted buckets -> base64 uploads -> completion
  jwt), then a multipart script PUT with metadata (main_module, bindings,
  assets jwt+config, tags, `keep_bindings: ["secret_text"]` so redeploys
  never drop secrets). Asset manifest hashes are salted with the project id
  (SHA-256 over `<pid>\0<bytes>`, truncated to 32 hex) so one tenant can
  never probe another's content by hash - dedup is per project on purpose.
- **Tags are `pid-<projectId>`**, not `project:<id>`: the scripts-by-tag
  filter grammar is `?tags=<tag>:yes`, so a colon inside a tag collides with
  it. Erase (`DELETE /internal/projects/:id`) bulk-deletes by that tag, then
  wipes the DO.
- **Limits ride the dispatch call**, not upload metadata:
  `DISPATCH.get(label, {}, { limits: { cpuMs: 50, subRequests: 50 } })`.
  Phase C changes this call, never the deployed scripts. Outbound parameters
  (`{ subdomain }`) are passed only under `DISPATCH_OUTBOUND=true`, which is
  set exactly where the wrangler env declares an `outbound` block - passing
  them without one throws.
- **`hosting-outbound` is its own tiny worker** (`src/outbound.ts`,
  `wrangler.outbound.jsonc`): the namespace binding names the service, so it
  must exist before any env referencing it deploys - `npm run
deploy:production` deploys it first. v1 is pass-through; Phase C's egress
  metering hooks in here without touching user scripts.
- **No demo hosting.** `DEMO_PROJECT_PATTERN` ids are refused at deploy
  (403) in both the console and the agent; there is no claim manifest entry
  because there are no demo caps to lift.
- **Hard v1 caps** in `src/agent.ts`: 2 apps, 50 deploys/day, 5 MB modules
  (measured uncompressed - stricter than the design doc's gzip phrasing),
  1000 assets / 25 MB per deploy. Phase C swaps constants for plan lookups.
- **The self-hosted default has NO `DISPATCH` binding** - WfP is a paid
  add-on and a binding to a missing namespace fails a zero-config deploy.
  The agent reports `configured: false` and answers deploys 503 with the
  setup steps; `HOSTING_STUB=true` (env.local/test only) records deploys and
  serves a fixed stub page instead. In stub mode the serve path honours an
  `x-cfbase-host` header in place of Host (local workerd is dialled by port);
  the header is ignored everywhere else.

## Commands

| Command                     | Purpose                                                              |
| --------------------------- | -------------------------------------------------------------------- |
| `npx tsc --noEmit`          | Typecheck (also runs the `bindings.test-d.ts` contract negatives)    |
| `npm run migrations`        | Generate migrations after `src/db/schema.ts` edits, then inline them |
| `npx wrangler types`        | Regenerate Worker types after binding changes                        |
| `npm run dev`               | env.local on :8790 (stub mode)                                       |
| `npm run dev:test`          | env.test on :8800 (the e2e stack's port)                             |
| `npm run build`             | Emit `dist/` for the published package                               |
| `npm run deploy:production` | Deploy `hosting-outbound` then the agent (`--env production`)        |

## Gotchas

- The entrypoint may only export handlers and DO classes; a value export
  fails at boot with `Incorrect type for map entry`. Type-only exports fine.
- Never pass `cors: true` to `routeAgentRequest`.
- Never hand-edit `src/migrations.ts` or `drizzle/`; run `npm run migrations`.
- Never name a file `src/env.ts` - it collides with `src/env.d.ts` and
  silently kills the ambient `Env` augmentation.
- `env.production` requires `CF_ACCOUNT_ID` + `CF_HOSTING_API_TOKEN` secrets
  and carries the `*.cfbase.dev/*` route - deploying it needs the zone to
  exist first (Phase B launch checklist in the design doc).
- The id schemas (`projectIdSchema`, `DEMO_PROJECT_PATTERN`) are deliberate
  copies mirrored across the console and all agents - keep them in sync.
