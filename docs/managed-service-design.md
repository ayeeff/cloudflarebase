# Managed service: accounts, organizations, and app hosting

Status: Phase A IMPLEMENTED (2026-08-11; drafted the same day). Phase B
(hosting) IMPLEMENTED (2026-08-12; amended the same day - subdomain
scheme, collision auto-numbering, GitHub deploys + deploy tokens; amended
again 2026-08-13 with the GitHub App - one install, no YAML the operator
writes, and still no build farm; the Phase B launch checklist and the
App's own checklist live at the end of the Phase B section). Phase
C (billing/metering) and Phase D (custom domains, orgs billing,
BYO-account enterprise) are deferred and
only sketched here. Phase A launch checklist for cloudflarebase.com, in
ORDER (mail is already configured, so flipping the mode is the switch
that opens sign-ups - it must come last, after the ownership guard is
live): 1. deploy agents by hand (auth -> db), 2. deploy the web worker, 3. sign in once to mint the founder's personal org, 4. run
`node scripts/backfill-org.mjs --org <orgId>` so no pre-org registry row
stays visible to every account, 5. set `CONSOLE_SIGNUPS=open` in the
auth worker's env.production vars and redeploy it. Optional, any time
after step 1: console social sign-in - register Google/GitHub OAuth apps
with redirect URI
`https://cloudflarebase.com/api/projects/console/auth/callback/<provider>`
and `wrangler secret put GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` /
`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` on the auth worker (console
instance only; per-project credentials stay in admin settings).

cloudflarebase.com becomes a managed Firebase alternative: sign up, create a
project, `cloudflarebase deploy`, and your app is live at
`<app>.cfbase.dev` with auth and database already wired - no Cloudflare
account, no wrangler config. The existing tiers stay and compose: anonymous
**demo** (the pitch), **managed** (this doc), **self-hosted** (unchanged,
default-private, free forever).

## The design in one sentence

**The managed service is the architecture we already run, opened up**: demo
mode is a managed service with anonymous users and ephemeral projects, so
Phase A is open sign-ups + ownership on the same substrate - and Phase B
adds the one thing the substrate cannot do (run user code) with the one
Cloudflare product built for it (Workers for Platforms).

## Customer zero: cloudflarebase runs on cloudflarebase

The console already authenticates operators against a real `AuthAgent`
under the reserved project id `console` - the same stack every customer
project runs (`src/lib/server/console.ts` documents the console as the
agent's "first customer"). The managed service deepens that, deliberately:

- **Open sign-ups ARE the console project's sign-ups.** A cloudflarebase
  account is a user row in the `console` AuthAgent. No parallel identity
  system, no drift: every sign-in path, session rule, and social flow the
  product offers customers is exercised by our own front door.
- **Organizations ship in `@cloudflarebase/auth` itself** (Better Auth's
  `organization` plugin), so every consumer project gets teams as a product
  feature - and the console is its first user: cloudflarebase orgs, members,
  and invitations are rows in the console AuthAgent's org tables.
- **Where dogfooding deliberately stops:** the project registry stays
  control-plane D1. The rationale in `src/lib/server/db/schema.ts` still
  holds - no agent may own the project list without every other agent
  depending on that one. Ownership therefore lives as an org id COLUMN on
  registry rows, referencing org rows that live in the console AuthAgent.
  The registry knows which org owns a project; the agent knows who is in
  the org; the guard joins the two per request.

## Phase A - accounts, organizations, ownership

### Auth agent changes (published in `@cloudflarebase/auth`)

- **Console sign-up modes.** Today the `console` instance accepts exactly
  one email sign-up (the first-run owner claim) and refuses the rest;
  `DEMO_MODE` refuses the claim entirely. A new env var on the auth worker,
  `CONSOLE_SIGNUPS`, selects the behaviour:
  - unset / `claimed` - the self-hosted default: first claim wins, then
    closed to strangers (refused under `DEMO_MODE`), exactly today - with
    ONE addition: the `denyUserCreation` veto allows a sign-up whose email
    holds a pending org invitation. Today's self-hosted console is
    literally single-operator; invitations give it teams without opening
    registration, so the private-by-default posture survives.
  - `open` - managed mode: public email sign-up with **required email
    verification**, and social sign-up creates users implicitly (today's
    unknown-account bounce is claimed-mode behaviour). Composes with
    `DEMO_MODE=true`: anonymous demos and real accounts coexist, which is
    cloudflarebase.com's launch configuration.
    The `denyUserCreation` veto in the user-creation database hook - the
    enforcement point every path converges on, social callback included -
    branches on the same mode. `GET /config` on the console instance reports
    the mode so `/login` can render sign-up affordances honestly.
- **The `organization` plugin** joins the plugin list for every project
  (anonymous users excluded from org creation). New Better Auth tables
  (`organization`, `member`, `invitation`, plus `session.activeOrganizationId`)
  land in `src/db/schema.ts` the usual way: `npm run migrations`, inlined
  into `src/migrations.ts`, applied idempotently in `onStart`, compared
  against `getAuthTables()` if the Better Auth upgrade shifts fields.
  Invitation emails ride the existing `sendEmail` hook.
- **Personal org on sign-up**, config-gated (`autoPersonalOrg`, on for the
  console instance): every account lands with one org it owns, so "personal
  project" is just an org with one member and the registry never needs a
  user-or-org union type. Consumers can enable the same hook for their own
  products.
- **One-round-trip membership resolution.** `GET /console/me` (agent route,
  console instance only): session + org memberships in a single response,
  joined locally in the DO. The dashboard's per-request guard must not pay
  two RPCs.
- **Session cookie cache.** Every operator request already resolves its
  session against the single console AuthAgent DO (~1k req/s ceiling).
  Managed mode multiplies operators, so Phase A enables Better Auth's
  signed `cookieCache` (60s) for the console instance - session reads
  become local signature checks and the DO sees sign-ins, not polling.
- **Outbound mail: Cloudflare Email Service.** (Amended at build time -
  the draft assumed the EMAIL binding was verified-destinations-only and
  planned a third-party HTTP transport; the deployment's binding is
  Cloudflare Email Service, which delivers to arbitrary recipients and is
  proven on real sign-up traffic, so no external provider exists.) Mail
  is the `EMAIL` binding + `EMAIL_FROM`, unchanged. Self-hosted installs
  stay zero-config: no sender means no verification mail, which is fine
  in claimed mode (the owner verified nothing today either); `open` mode
  REQUIRES the configured sender and the agent refuses to open sign-ups
  without one - so on a mail-configured deployment, setting
  `CONSOLE_SIGNUPS=open` is itself the launch switch.

### Control plane and console changes

- **Registry ownership**: `project.org_id TEXT` (runtime CREATE plus
  duplicate-column-tolerant ALTER, the `parent_id` precedent). Null means
  a legacy/self-hosted row: visible to any operator, exactly today's
  behaviour, so a claimed-mode install never notices any of this. In open
  mode, project creation requires an active org and stamps it; branch rows
  copy the root's `org_id`; the root-delete cascade is unchanged.
- **Guard scoping**: `consoleGuardHandle` currently grants any session
  everything. It gains an ownership check on project-scoped surfaces
  (`/api/projects/<id>/**`, the `/agents/*` passthrough, dashboard pages):
  resolve memberships via `/console/me` (memoized per request, like
  `locals.consoleUser`), then require `row.org_id` ∈ memberships or
  `row.org_id IS NULL`. Reserved ids (`console`) and demo families keep
  their existing special-casing. `/admin` stays `ADMIN_SECRET`-gated and
  fleet-wide.
- **Backfill**: cloudflarebase.com's existing projects get the founder's
  personal org id in a one-time script; self-hosted installs need nothing.
- **UI**: `/login` grows sign-up (email + verification notice, social);
  an org switcher keyed on `activeOrganizationId`; an Organization page
  (members, invitations, rename); the projects overview lists the active
  org's projects and keeps the branch nesting. Demo visitors see none of
  this - `locals.consoleUser` already gates the registry surfaces.

### Demo claim - REMOVED 2026-08-12

Phase A originally shipped a "Keep this project" claim flow (registry row
for the demo id + a claim fan-out that lifted agent caps and disarmed the
TTL). It was removed: keeping the demo-shaped id made claimed projects
permanent second-class citizens (hosting refuses demo-shaped ids by
design, the ugly id lives in every API path forever), and fixing that
honestly means data migration to a real id - complexity nobody asked for.

Demos are now throwaway 30-day applications, full stop (`DEMO_TTL_HOURS`,
720h on cloudflarebase.com): demo-shaped ids are never registry rows
(creation refuses them), no agent has a claim route or a claimed flag, and
the guard treats every demo-shaped id as anonymous possession-based state.
A visitor who wants to keep something signs up and creates a real project.

### What Phase A deliberately does NOT change

Self-hosted defaults (claimed console, no mail, no open registration -
orgs arrive there too, but only invitations can mint users), the agents'
hot paths, the db agent, demo flows and caps, the CLI (its login
against the console instance keeps working verbatim - bearer sessions are
mode-independent), `/admin`, and the publishing model.

## Phase B - hosting: apps and functions on Workers for Platforms

### Why Workers for Platforms and not plain Workers

`cloudflarebase deploy` accepting user build output means executing
untrusted code. As regular Workers on our account that is a dead end three
ways: accounts cap at 500 scripts, there are no per-tenant CPU or
subrequest limits, and user code could reach internal surfaces from inside
our account. Workers for Platforms is the sanctioned answer: dispatch
namespaces hold unlimited user Workers ($25/mo base, 1,000 scripts
included, $0.02/script after) with **custom limits** per script, an
**outbound Worker** intercepting every `fetch()` user code makes, and
**static assets** support - which is the unifying trick: an "app" (static
site, SSR frontend) and "backend functions" are the same artifact, one
user Worker with an assets manifest. Firebase Hosting + Cloud Functions
collapse into a single primitive and a single deploy.

### The hosting agent

A new primitive following the agent contract (`docs/agent-contract.md`):
`agents/hosting`, worker `hosting-agent`, published as
`@cloudflarebase/hosting`, manifest-registered in
`src/lib/agent-registry.ts` like the others.

- **`HostingAgent` DO, one per project** (`scope: perProject`): the app
  registry for that project, deploy history, and the orchestration of the
  Cloudflare API (asset upload sessions, script puts). Control plane, not
  data plane - the DO stores metadata; the code and assets live in the
  dispatch namespace.
- **The same worker serves `*.cfbase.dev`** - role decided by hostname,
  the LiveShard precedent: requests on the wildcard route take the first
  host label and `env.DISPATCH.get(hostLabel)`, zero lookup, because **the
  script name IS the full subdomain**. Dispatch NEVER parses the
  subdomain into app and branch - any ambiguity between an app named
  `x-2` and branch `2` of app `x` is resolved by the claims table at
  deploy time, never by string surgery at serve time. Unclaimed
  subdomain = no script = branded 404. Reserved names (`www`, `api`,
  `console`, `admin`, `docs`, `status`, `mail`, `cfbase`, ...) never
  dispatch.
- **Bindings**: `DISPATCH` (namespace `cfbase-apps` in `env.production`,
  `cfbase-apps-preview` in `env.preview`; **absent from the top-level
  self-hosted default** - Workers for Platforms is a paid add-on, and a
  binding to a namespace the account does not have would fail a fresh
  clone's zero-config deploy, so the agent treats a missing `DISPATCH`
  as "hosting not configured" and answers 503 with a pointer instead),
  `CF_ACCOUNT_ID` var, `CF_HOSTING_API_TOKEN` secret (Workers Scripts
  edit, scoped to the namespace operations), optional `SENTRY_DSN`. No
  registry access - subdomain claims go through the console, which owns
  the control plane, so no agent owns global state.
- **Erase fan-out**: `DELETE /internal/projects/:id` lists namespace
  scripts by the project-id **tag** every deploy stamps (`pid-<id>` -
  NOT the drafted `project:<id>`, because the scripts-by-tag filter
  grammar is `?tags=<tag>:yes|no`, so a colon inside a tag collides with
  the filter syntax), deletes them, then destroys the DO. A new call in
  `deleteProject`, per the contract. The console also releases the
  project's rows in the `app` claims table.

### Subdomains and claims

Global namespace, so claims live in the control plane: D1 table `app` -
`subdomain` PK, `project_id` (the FULL registry id, branch ids included:
a branch is its own registry row, so it is its own claim row),
`app_name` (the operator-chosen name the subdomain was derived from),
`created_at`. App-name charset `/^[a-z0-9][a-z0-9-]{2,47}$/`, no `--`,
reserved list enforced at claim. Project delete releases the row.

**The subdomain scheme** (amended 2026-08-12, wins over the earlier
`<app>--<b>` draft):

- A deploy from the ROOT project serves at `<app>.cfbase.dev`.
- A deploy from branch `<root>--<b>` serves at `<app>-<b>.cfbase.dev` -
  single dash. `main` never appears in a URL: it aliases the root and is
  a refused branch name, so the bare subdomain IS main.

**Collisions auto-number, never fail.** If the wanted subdomain is
taken, the claim takes the first free `<wanted>-2`, `<wanted>-3`, ..., and
what was actually claimed is reported everywhere the operator sees it:
the deploy response, the CLI output, and the dashboard Hosting page. The
RESOLVED subdomain is persisted on the `app` row for that
project+branch on FIRST claim and reused verbatim afterwards - never
re-derived - so URLs stay stable even when neighboring claims appear or
are released later. Interactive bare `cloudflarebase init` shows the
numbered suggestion before claiming; CI and branch deploys just take it.
Branch deploys inherit the family's app name and claim their own row
lazily on first deploy - preview environments per branch fall out of
the id scheme, the branches-design payoff repeating.

### Deploy tokens

CI cannot deploy on an operator session - bearers expire with the
session. Deploy tokens are the durable, revocable credential, designed
deliberately SMALL:

- **Minted and revoked from the Hosting page** (root projects only; a
  token covers the root and all its branches). The secret is
  `cfbd_<64 hex>`, shown once at mint.
- **Stored HASHED in the control plane**: D1 table `deploy_token` - `id`
  PK, `project_id` (root), `name`, `token_hash` (SHA-256 hex),
  `created_at`, `last_used_at`. Revocation deletes the row; the digest
  means a control-plane leak never yields a working credential.
- **Accepted ONLY by the deploy surface**: the console guard recognizes
  the `cfbd_` bearer prefix and admits it solely for
  `POST /api/projects/<id>/hosting/apps/<app>/deploys` and
  `POST /api/projects/<id>/branches` (CI auto-creating the branch row
  for a new git branch), where `<id>` must be the token's root or one of
  its branches. Everywhere else a deploy token is a plain 401 - it is
  never a session, never an identity, and mints nothing but deploys.

### The deploy flow

1. Bare `cloudflarebase init` (amended at build time: originally drafted
   as a new `link` command, renamed on user preference - the vocabulary
   follows wrangler/Netlify, where `init` means "set up this directory",
   while `init <name>` keeps scaffolding a self-hosted Worker) signs in
   via the existing `/cli-auth` hand-off, picks/creates a project, claims
   an app subdomain (showing the auto-numbered suggestion first when the
   wanted name is taken), and writes `cloudflarebase.json`
   (`{ project, app, origin }` - `project` is always the ROOT id; the
   branch is decided per deploy).
2. `cloudflarebase deploy` **branches on context**: `cloudflarebase.json`
   present → managed deploy; otherwise today's self-hosted wrangler path,
   unchanged. Managed deploy resolves the target branch (`--branch`, else
   the current git branch: the default git branch maps to the root,
   anything else to `<root>--<branch>`), bundles the Worker if the user's
   `wrangler.jsonc` declares a `main` (via `wrangler deploy --dry-run
--outdir` so wrangler does the bundling; a bare assets directory
   deploys as an assets-only Worker), then multipart-uploads modules +
   assets to `POST /api/projects/<id>/hosting/apps/<app>/deploys` with
   the CLI bearer token OR a deploy token - the ordinary guard path,
   ownership-checked by Phase A.
3. **The console resolves the claim before proxying** (claims are control
   plane; the agent owns no global state): reuse the persisted `app` row
   for this project+branch or mint one per the auto-numbering rule, refuse
   demo ids with the 403 upsell, then forward to the `HostingAgent` with
   the resolved subdomain. The agent drives the Cloudflare API: asset
   upload session (project-salted manifest hashes → wanted buckets →
   base64 uploads → completion token), then
   `PUT /dispatch/namespaces/<ns>/scripts/<subdomain>` with multipart
   metadata: modules, assets token + config, **tags** (`pid-<id>`),
   `keep_bindings: ["secret_text"]` so redeploys never drop secrets, and
   bindings - injected `PROJECT_ID` + `CLOUDFLAREBASE_URL` plain-text
   vars so the SDK works out of the box, plus user vars from
   `cloudflarebase.json`. Secrets: `cloudflarebase secret put <name>`
   (wrangler's verb) PATCHes the script settings with a `secret_text`
   binding under the same `keep_bindings` discipline.
4. The response is the live URL with the subdomain that was ACTUALLY
   claimed. Deploy history lands in the DO; the dashboard's Hosting page
   lists apps, deploys, tokens, and the URL per branch.

### GitHub deploys - Workers-Builds-style without running a build farm

Phase B ships CI deploys as an official GitHub Actions workflow, not a
hosted build service (webhook-driven builds on our infra stay Phase D):

- **The workflow is checkout → user's build → `cloudflarebase deploy`**,
  authenticated by a deploy token in the repo's secrets
  (`CLOUDFLAREBASE_DEPLOY_TOKEN`, read by the CLI from the environment).
- **Git branch maps to cloudflarebase branch**: the default git branch
  deploys the root; any other branch deploys `<root>--<branch>`,
  auto-creating the branch row through the existing `createBranch` when
  missing (the deploy token authorizes exactly that) - so
  preview-per-git-branch falls out of the branches design.
- **The dashboard Hosting page has a "Connect GitHub" card** that mints a
  deploy token and generates the ready-to-commit workflow YAML
  (single-sourced in `src/lib/hosting-workflow.ts`). Nothing to install,
  no GitHub App, no OAuth - the trust anchor is the token the operator
  pastes into their repo secrets. The card deep-links GitHub's new-file
  editor with the workflow PRE-FILLED plus the repo's secrets page, so
  setup is two clicks on GitHub - after which every push deploys
  automatically. This manual path is now the FALLBACK, kept for consoles
  with no GitHub App configured (the self-hosted default); the App path
  below supersedes it wherever one exists.

### The GitHub App - one install, no YAML, still no build farm

Amended 2026-08-13. The question the section above deferred ("could this
be a Workers-Builds-style bot with no setup at all?") splits in two once
you ask what the repository actually needs, and only ONE half requires a
build farm:

- **`build` mode** - the repository has a build step, so it has to be
  built somewhere, and that somewhere stays GitHub's runners. The App
  writes `.github/workflows/cloudflarebase.yml` on the operator's behalf
  (`contents: write`), so the operator never sees YAML even though a file
  exists. **No secret is stored anywhere**: the workflow declares
  `id-token: write` and the CLI mints a GitHub OIDC token, which the
  console verifies against GitHub's JWKS - the same mechanism this repo
  already uses to publish to npm. Nothing to rotate, nothing to leak.
- **`direct` mode** - the repository needs no build (committed HTML, or a
  committed output directory), so it needs no runner AND no file in the
  repository at all. The push webhook fetches the commit tarball and hands
  it to the hosting agent. Zero Actions minutes, zero repo footprint.
  This covers plain static sites, which is a large share of "just deploy
  my site".

Which mode a repository gets is INSPECTED at connect time (a `build`
script in `package.json` → build; committed `dist`/`build`/`public`/... or
a root `index.html` → direct; unreadable → build, which degrades to "the
runner reports the problem" rather than publishing the wrong tree). The
operator can override in the connect dialog.

Mechanism:

- **Credentials are four optional secrets on the WEB worker**
  (`GITHUB_APP_ID`, `_SLUG`, `_PRIVATE_KEY`, `_WEBHOOK_SECRET`), all or
  nothing. Unconfigured is the self-hosted default and the whole feature
  reads as absent: the Hosting page offers the manual token flow, the
  connect routes 503 honestly, and the webhook 404s. Pinned by
  `e2e/github-connect.api.spec.ts` - adding push-to-deploy must not open a
  single new surface on an install that never asked for it.
- **GitHub hands out PKCS#1 private keys and WebCrypto imports only
  PKCS#8**, so `server/github.ts` wraps PKCS#1 in a `PrivateKeyInfo`
  rather than making every operator run `openssl pkcs8` before pasting the
  key (verified byte-identical to node's own PKCS#8 encoding).
- **The install callback is the ONE moment an `installation_id` is
  trustworthy** - it arrives on a redirect anyone can craft, so it is only
  believed while accompanied by state we signed, for the operator holding
  the session. The callback records the installation → org binding once;
  every later connect checks that binding instead of the id.
- **Two independent checks authorize a deploy**: GitHub's signature proves
  which REPOSITORY is calling, and the `github_connection` table says
  which PROJECT that repository may deploy to. A verified token for an
  unconnected repo grants nothing, which keeps the trust anchored in the
  console. `direct` connections are excluded from OIDC deliberately - they
  deploy from the webhook and never present a token, so accepting one
  would be a second, unaudited path into the same app.
- **The webhook is the only unauthenticated route under `/api`**, and has
  to be: GitHub carries no session. Its HMAC signature is checked over the
  RAW body before the payload is parsed. It acts only on `direct`
  connections - `build` repositories are deployed by Actions, which
  triggers on the same push.
- **Connections live on the ROOT project** and cover its branches, exactly
  like a deploy token: a push to the default branch deploys the root, any
  other branch creates and deploys `<root>--<branch>`.
- **The console resolves the tarball URL from GitHub's 302**, so the
  installation token never leaves the control plane - the agent receives a
  signed, short-lived URL it fetches anonymously, and only from GitHub
  hosts. The agent's `gitDeploy` unpacks it (`agents/hosting/src/tar.ts`,
  a bounded tar+gzip reader: the byte ceiling is enforced WHILE
  decompressing, because a decompression bomb is a handful of bytes on the
  wire) and calls the same `publish()` the multipart route calls, so caps
  and bookkeeping cannot diverge between the two paths.

What is still Phase D: running the user's `npm run build` on OUR
infrastructure. That is the only remaining reason to want a build farm,
and it buys exactly one thing the above does not - a repository that
builds AND has no file in it.

**Setting the App up** (once per deployment; see the launch checklist):
register a GitHub App with `contents: write` (writes the workflow) and
`metadata: read`, subscribe it to the `push` and `installation` events
pointed at `<origin>/api/github/webhook`, set the callback URL to
`<origin>/api/github/callback`, then `wrangler secret put` the four
values. Public repos and private repos behave identically; the
installation token only ever reaches repositories the operator selected.

### Guardrails from day one

- **Custom limits** on every script (CPU ms, subrequests) - fixed in B,
  plan-driven in C. (Amended at build time: the current WfP API applies
  limits at DISPATCH time - `env.DISPATCH.get(name, {}, { limits:
{ cpuMs, subRequests } })` - not in upload metadata, which is strictly
  better for us: C can change a tenant's caps without touching their
  deployed script.)
- **Outbound Worker** on the namespace from the first deploy: v1 is
  pass-through plus the dispatched subdomain in its parameters (the
  project is joinable offline via the claims table - the serve path stays
  zero-lookup), which is what C's egress metering and policy blocking
  hook into without a redeploy of user scripts. It is its own tiny Worker
  (`hosting-outbound`, shipped inside `agents/hosting`), because the
  outbound service is named in the dispatch-namespace binding and must
  exist before the hosting worker deploys.
- **Hard fixed caps**: apps per project (2), deploys per day (50), bundle
  size (5 MB gzip), assets (1000 files / 25 MB per deploy, within
  platform limits). Enforced in the HostingAgent; C replaces the
  constants with plan lookups.
- **No demo hosting.** Anonymous code execution is an abuse machine; demo
  projects get an upsell card, and BOTH the console deploy route and the
  agent answer 403 for demo ids.
- **Assets stay per-tenant**: identical-hash assets are shared within a
  namespace unless hashes are salted - the agent computes manifest hashes
  as SHA-256 over the project id plus the file bytes, so one tenant can
  never probe another's content by hash.

### Serving, DNS, TLS

The `cfbase.dev` zone (to register) carries a proxied wildcard
`*.cfbase.dev` route to `hosting-agent` in `env.production`. Universal SSL
covers exactly one wildcard level, which the flat `<app>.cfbase.dev` and
`<app>-<branch>.cfbase.dev` scheme respects by construction. The zone
apex redirects to cloudflarebase.com. Customer custom domains are Phase D
(Cloudflare for SaaS custom hostnames on the same dispatch path).

### Local dev and e2e

Dynamic script upload has no local simulator. `HOSTING_STUB=true`
(env.local/test) makes the agent record deploys in DO state and the
dispatch path serve a fixed stub page - the full CLI → console → agent
contract runs in Playwright without the Cloudflare API. In stub mode the
serve path also honours an `x-cfbase-host` header in place of the Host
header, because local workerd is dialled by port, not by subdomain; the
header is ignored everywhere else. The hosting agent takes the next port
pair: dev 8790, e2e 8800. Real upload/serve coverage is a small opt-in
spec (`RUN_HOSTING_E2E=1`, the `RUN_AI_E2E` precedent) against the
`-preview` namespace, because preview has no `cfbase.dev` route and
serving is only verifiable where the wildcard exists.

### Phase B launch checklist for cloudflarebase.com (manual, in order)

1. Register the `cfbase.dev` zone on the Cloudflare account.
2. Subscribe to Workers for Platforms and create the dispatch
   namespaces: `npx wrangler dispatch-namespace create cfbase-apps` and
   `... create cfbase-apps-preview`.
3. Mint the `CF_HOSTING_API_TOKEN` API token (Account > Workers Scripts:
   Edit) and set it with `wrangler secret put` on the hosting worker
   (production and preview), plus `CF_ACCOUNT_ID` as a var.
4. Deploy the environment's outbound worker, then the hosting agent
   (`npm run deploy:production` / `deploy:preview` inside `agents/hosting`
   deploy both in order; preview gets its own `hosting-outbound-preview`
   so preview-branch outbound code never serves production egress), then
   the web worker.
5. Add the wildcard route: `*.cfbase.dev/*` → `hosting-agent` on the
   `cfbase.dev` zone (declared in the agent's `env.production` routes;
   the deploy claims it once the zone exists).

### GitHub App checklist (per deployment; optional everywhere)

Independent of the list above - hosting works without it, and an install
that skips it keeps the manual deploy-token flow. Do it once per
environment, because the callback and webhook URLs are origin-specific
(production and preview need SEPARATE Apps).

1. **Register the App** at
   `https://github.com/settings/apps/new` (or under an org):
   - Homepage URL: `<origin>`
   - Callback URL: `<origin>/api/github/callback`, "Request user
     authorization (OAuth) during installation" OFF - the console binds
     the installation through its own signed state, not a user token.
   - Setup URL: leave blank (the callback handles the redirect).
   - Webhook URL `<origin>/api/github/webhook`, Active ON, and a secret
     you generate (`openssl rand -hex 32`).
   - Repository permissions: **Contents: Read and write** (writes the
     workflow, reads the tarball) and **Workflows: Read and write**
     (GitHub refuses to create a file under `.github/workflows/` without
     it). Metadata: Read-only is implied.
   - Subscribe to events: **Push** and **Installation**.
   - Where can this be installed: "Any account" for a public service.
2. **Generate a private key** on the App's page. It downloads as PKCS#1
   (`BEGIN RSA PRIVATE KEY`) - paste it VERBATIM, no `openssl pkcs8`
   conversion; `server/github.ts` wraps it.
3. **Set the four secrets** on the WEB worker (`wrangler secret put`, in
   the right environment): `GITHUB_APP_ID` (the numeric App ID),
   `GITHUB_APP_SLUG` (the URL slug from
   `https://github.com/apps/<slug>`), `GITHUB_APP_PRIVATE_KEY`,
   `GITHUB_APP_WEBHOOK_SECRET`. All four or the App reads as
   unconfigured - there is no half-configured state.
4. **Verify**: the Hosting page's GitHub card should offer "Connect
   repository" instead of the manual token steps, and GitHub's App
   settings → Advanced should show a green `ping` delivery.

## Deferred: Phase C and D sketches

- **C - plans, metering, billing**: per-project plan column pushed to
  agents via a service-binding-only `PUT /internal/projects/:id/plan`
  (the erase-route precedent) replacing demo-cap constants with plan caps;
  WfP namespace analytics by script tag + outbound-worker egress metering
  - DO storage sizes rolled into a D1 usage table; Stripe subscriptions on
    the org (Phase A made orgs the billable entity on purpose); dunning
    downgrades caps, termination reuses the delete pipeline. Per-project
    throughput ceilings land here (the documented gap: per-IP limiting is an
    abuse ceiling, not tenant fair-share).
- **D - growth**: customer custom domains (Cloudflare for SaaS), org
  billing roles, cloud builds (git push → build), tail-worker log
  streaming into the console, BYO-account managed enterprise (the console
  managing a self-hosted install over public HTTP - service bindings do
  not cross accounts, so this is a separate product surface, deliberately
  not Phase B).

## Costs and edges

- **The console AuthAgent is one DO.** cookieCache (A) defers the ceiling;
  if managed traffic ever saturates it, session verification can go
  stateless via the console's own JWKS - the same trick every customer
  project already gets. Designed relief valve, not built until needed.
- **Single-account concentration**: the whole managed fleet rides one
  Cloudflare account. Accepted for now; the eventual mitigation is
  cell-per-region accounts, a Phase-much-later concern.
- **WfP economics**: $25/mo base + $0.02/script/mo past 1,000 + request/
  CPU overage, billed to us - why B ships with hard caps and C exists.
- **Email dependency**: `open` sign-ups stand on Cloudflare Email
  Service delivering; the agent refusing open mode without a configured
  sender turns a silent failure into a config error at deploy time.
- **Subdomain squatting**: reserved list + charset now; rate of claims per
  org and reclaim policy when it becomes a real problem, not before.
- **Script-name migrations**: the subdomain-is-script-name scheme means a
  rename is claim + redeploy + release, never a mutable alias table. A
  deliberate trade for the zero-lookup dispatch hot path.

## Decisions to confirm at build time

- ~~Email provider~~ CONFIRMED at build time: Cloudflare Email Service
  (the existing `EMAIL` binding) - no third-party sender.
- Better Auth organization plugin option surface (roles beyond
  owner/admin/member, invitation expiry) - pin against the installed
  version's `getAuthTables()` when the schema lands.
- Exact v1 caps (CPU ms, bundle size, apps/deploys per project) - set
  from WfP platform limits and demo-cap experience at implementation.
