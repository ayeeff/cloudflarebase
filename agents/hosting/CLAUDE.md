# Hosting Agent

Apps and functions on Workers for Platforms (docs/managed-service-design.md,
Phase B). One `HostingAgent` Durable Object per project orchestrates deploys;
the SAME worker serves its environment's apex (`cfbase.dev` in production,
`cfbase-preview.dev` in preview) by dispatching the first host label into the
namespace - the script name IS the full subdomain, zero lookup, and dispatch
NEVER parses a subdomain into app and branch (the control plane's claims
table resolved that at deploy time). Nothing in the code names a domain:
`HOSTING_DOMAIN` is a suffix the serve path strips, which is why a second
zone was a config change and not a code one.

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
deploy:production` / `deploy:preview` deploy it first. v1 is pass-through;
  Phase C's egress metering hooks in here without touching user scripts.
  **One outbound per environment** (`hosting-outbound-preview` for the
  preview namespace): the preview CI redeploys the outbound on every push
  to `preview`, so a shared instance would put preview-branch outbound code
  on production apps' egress - and Phase C's metering must be rehearsable
  on preview without touching production.
- **Two deploy entry points, one publisher.** `deployApp` (multipart, the
  CLI's path) and `gitDeploy` (a repository tarball, from a push webhook the
  console verified) both parse into modules+assets and then call `publish()`,
  which owns every cap, the WfP upload, and the deploy record - so the two
  paths cannot drift apart. `gateDeploy` runs the demo refusal, the claim
  check, and the daily ceiling before either reads a body.
- **`gitDeploy` never holds a GitHub credential.** The console resolves
  GitHub's tarball 302 into a signed, short-lived codeload URL and passes
  that; `/internal/projects/:id/apps/:app/git-deploy` additionally refuses
  any URL that is not on a GitHub download host, because the agent fetches
  it server side. `src/tar.ts` is the reader: bounded WHILE decompressing
  (a decompression bomb is a handful of bytes on the wire), regular files
  only (a symlink would be a path-traversal primitive), dotfiles and
  `node_modules` dropped, and a missing assets directory selects NOTHING
  rather than falling back to the repo root - a typo must not publish the
  whole source tree. Pinned by `src/tar.unit.test.ts` against a real bsdtar
  archive, including a path too long for tar's 100-byte name field (it
  travels as a PAX extended header; getting it wrong truncates silently).
- **No demo hosting.** `DEMO_PROJECT_PATTERN` ids are refused at deploy
  (403) in both the console and the agent - demos are throwaway and never
  run code.
- **Hard v1 caps** in `src/agent.ts`: 2 apps, 50 deploys/day, 20 MB modules
  (measured uncompressed - Cloudflare's own 10 MB-compressed script ceiling
  still applies at upload), 5000 assets / 40 MB per deploy, 25 MB per file.
  Raised 2026-08-15 for framework output (an OpenNext bundle passes 10 MB,
  `_next/static` alone passes 1000 files); the asset total is also a DO
  memory bound - deploys parse in isolate memory, so keep it well under
  128 MB. Phase C swaps constants for plan lookups.
- **Root convention files never publish as assets.** `publish()` drops
  root-level `_worker.js`, `_routes.json`, `_headers`, `_redirects`
  (`RESERVED_ROOT_ASSETS`) on BOTH deploy paths: for frameworks whose assets
  directory is also their build output (SvelteKit, Astro SSR), `_worker.js`
  is the customer's server bundle, and publishing it hands out their server
  source at `https://<app>.cfbase.dev/_worker.js`. The CLI additionally
  honours the output directory's `.assetsignore`; this filter is the
  backstop for older CLIs and direct tarball deploys.
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
| `npm run test:unit`         | Tar/gzip reader tests against a real archive (direct git deploys)    |
| `npm run migrations`        | Generate migrations after `src/db/schema.ts` edits, then inline them |
| `npx wrangler types`        | Regenerate Worker types after binding changes                        |
| `npm run dev`               | env.local on :8790 (stub mode)                                       |
| `npm run dev:test`          | env.test on :8800 (the e2e stack's port)                             |
| `npm run build`             | Emit `dist/` for the published package                               |
| `npm run deploy:production` | Deploy `hosting-outbound` then the agent (`--env production`)        |
| `npm run deploy:preview`    | Deploy `hosting-outbound-preview` then the agent (`--env preview`)   |

## Gotchas

- The entrypoint may only export handlers and DO classes; a value export
  fails at boot with `Incorrect type for map entry`. Type-only exports fine.
- Never pass `cors: true` to `routeAgentRequest`.
- Never hand-edit `src/migrations.ts` or `drizzle/`; run `npm run migrations`.
- Never name a file `src/env.ts` - it collides with `src/env.d.ts` and
  silently kills the ambient `Env` augmentation.
- `env.production` and `env.preview` both require `CF_ACCOUNT_ID` +
  `CF_HOSTING_API_TOKEN` secrets and both carry a wildcard route -
  `*.cfbase.dev/*` and `*.cfbase-preview.dev/*`. Deploying either needs its
  zone to exist on the account first (Phase B launch checklist in the
  design doc), and a deploy fails outright on a missing zone rather than
  degrading. Preview has its OWN zone because a wildcard route maps to one
  Worker, and `*.preview.cfbase.dev` would be two levels deep - beyond
  Universal SSL's apex-plus-one-level coverage, so it would need paid
  Advanced Certificate Manager forever.
- The id schemas (`projectIdSchema`, `DEMO_PROJECT_PATTERN`) are deliberate
  copies mirrored across the console and all agents - keep them in sync.
