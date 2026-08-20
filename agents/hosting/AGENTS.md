# @cloudflarebase/hosting

Static sites and Workers on Workers for Platforms, served at
`<subdomain>.<HOSTING_DOMAIN>`. One `HostingAgent` per project.

Read the root [AGENTS.md](../../AGENTS.md) first.

## Two workers, and one of them has two roles

`wrangler.jsonc` deploys `hosting-agent`; `wrangler.outbound.jsonc` deploys the
dispatch namespace's **outbound worker** separately. `deploy:production` runs
both, outbound first — deploy them together or the namespace loses its egress
hook.

`hosting-agent` itself branches on **hostname**:

- **Serving** — a request on the `*.<domain>` wildcard route takes the first
  host label and does `env.DISPATCH.get(hostLabel)`. Zero lookup, because the
  script name *is* the full subdomain; dispatch never parses it back into app
  and branch. An unclaimed subdomain is simply no script, and gets the branded
  404.
- **Agent surface** on every other hostname — `/health`, `/internal/*`, and
  `routeAgentRequest`. `/internal/*` is reachable only over the dashboard's
  service binding: this Worker has no public route beyond the wildcard, and the
  serve branch swallows every wildcard request before dispatch gets here.

The serve path never touches `HostingAgent`. Control plane and data plane are
fully separate, same as storage.

## What only holds here

- **Subdomains are pushed by the console**, resolved from the control-plane
  `app` claims table. The agent never derives or accepts one from a request —
  that is what makes the deploy route safe on the operator surface: it can only
  ever deploy to subdomains the console recorded for *this* project.
- **The cache shim is not optional.** Workers for Platforms runs namespaced
  scripts in untrusted mode, which is what isolates tenants — and in that mode
  `caches.default` throws and `request.cf` is absent. Frameworks call it
  unconditionally (SvelteKit's adapter opens every request with
  `caches.default.match(req)`), so an unmodified build 500s on every SSR route.
  Each module deploy gets a generated entry that imports the shim **first** and
  re-exports the customer's entry: ES modules evaluate imports depth-first in
  source order, so a module-scope capture like `var s2 = caches.default` picks up
  the neutralised methods. Generated names carry a `__cfbase` prefix so a
  customer file can never be shadowed. The namespace-level `trusted_workers`
  flag would fix it by turning tenant isolation off for every app at once — the
  opposite trade.
- **Asset manifest hashes are salted with the project id** (SHA-256 over
  `<projectId>\0<bytes>`, truncated to the API's 32 hex chars). Assets are
  deduplicated *by hash* within a namespace, so unsalted hashes would let one
  tenant probe another's content.
- **A tarball is attacker-controlled input.** `tar.ts` is bounded everywhere: the
  gunzip reader checks the ceiling *as bytes arrive*, never after — waiting
  until the end is what a decompression bomb wants.
- **Deploys are parsed in memory**, so the limits in `agent.ts` are sized against
  the 128 MB isolate: 20 MB modules, 5000 assets, 40 MB asset total, 25 MB per
  file. Cloudflare's own 10 MB-compressed script ceiling still applies at upload.
- **Hosting has no public routes at all.** Its whole manifest route table is
  operator: `/overview`, `/apps/*`, `/deploys`.

## App environments

Three stores per app, three different trust shapes — never mix them up:

- **Runtime vars** (`app_vars`): plaintext at rest on purpose — they upload as
  `plain_text` bindings anyway, and DO storage is the trust boundary. Applied
  on every deploy as platform > stored > the CLI's `meta.vars` (the console is
  the canonical editor), and PATCHed onto the live script on edit. The patch
  replaces the WHOLE `plain_text` set (that is how a deletion disappears), so
  `apps.last_deploy_vars` snapshots the CLI's vars to rebuild it without the
  CLI present. Store-first: an edit is never lost to a transient API failure.
- **Runtime secrets** (`app_secrets`): the value is write-through to
  Cloudflare's script settings (that is the runtime binding; deploys carry
  `keep_bindings: ['secret_text']` so it survives), AND stored AES-256-GCM
  under `HOSTING_MASTER_KEY` when the install has one, so builds receive it —
  the Pages model: frameworks inline env at build time. The AAD carries a
  `runtime\0` prefix so this ciphertext and a build secret's are never
  interchangeable. Null ciphertext (keyless install, or rows from before the
  column existed) means runtime-only: the bundle skips it rather than failing
  the build. The operator surface still answers names only. Delete uses the
  per-script secrets endpoint (404-tolerant), then drops the row — a failed
  CF delete keeps the row, which is the honest state.
- **Build env** (`build_vars` / `build_secrets`, ROOT project only —
  connection-scoped): build-only OVERRIDES. The bundle the GitHub Actions
  workflow fetches via its OIDC token is runtime vars+secrets merged under
  these (`src/build-env.ts` pins build-wins-on-collision). Build secrets are
  AES-256-GCM under `HOSTING_MASTER_KEY` (`src/crypto.ts`: `v1:<iv>:<ct>`
  versioned format, row-bound AAD `<appName>\0<name>`). Decrypted values only
  ever transit the service-binding-only `/internal/.../build-env` route; the
  operator surface answers names only. No key ⇒ build-secret writes 503;
  encrypted rows with no key ⇒ the bundle route fails loud rather than build
  without secrets.

`eraseApp` clears all three even without an `apps` row — claim-only apps can
be configured before their first deploy.

## Analytics

The serve path writes one Analytics Engine data point per dispatched request
(`index1` = subdomain, `blob1` = status, `double1` = duration ms) — the
subdomain IS the script name, so the DO joins it back to an app with zero
lookups. Unclaimed-subdomain 404s are deliberately not recorded. The read
(`GET /apps/:app/analytics`) mirrors the auth agent's ladder: `connected`
(CF_ACCOUNT_ID + CF_ANALYTICS_API_TOKEN + WAE_DATASET) → `local` (the
LOCAL_ANALYTICS D1 stand-in local dev and e2e read back) → `write-only` →
`error`, and a failed query answers 200 with zeroed series, never a 5xx. The
top-level wrangler.jsonc declares NO dataset — Analytics Engine is an
account-level opt-in and the binding fails a fresh clone's deploy (code
10089, the auth precedent).

## Degradation

Workers for Platforms is a paid product. Without `CF_ACCOUNT_ID` +
`CF_HOSTING_API_TOKEN` + a dispatch namespace, deploys answer 503 and the rest
of the stack is unaffected. `HOSTING_DOMAIN` empty disables the serving path.
`HOSTING_MASTER_KEY` unset disables only build-secret writes.

Stub mode (`HOSTING_STUB=true`) stubs the Cloudflare API, never the logic:
deploys are recorded, secrets store their names (and answer ok), build-secret
encryption is REAL (local/test pin a dev master key as a var), and analytics
read the local D1 — which is what lets e2e exercise every contract on every
run. The two shapes only a live namespace proves — the settings PATCH on an
assets-only script and the per-script secrets DELETE — are gated by the
opt-in `RUN_HOSTING_E2E` spec; do not call those surfaces "verified" on a new
account until it has passed.

## Commands

```bash
npm run dev              # wrangler dev --env local, :8790
npm run typecheck
npm run test:unit        # route-access, tar, cloudflare, crypto
npm run deploy:outbound  # the outbound worker — needed before the agent
npm run migrations
```
