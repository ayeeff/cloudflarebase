# Managed service: accounts, organizations, and app hosting

Status: Phase A IMPLEMENTED (2026-08-11; drafted the same day). Phase B
(hosting) is approved and next. Phase C (billing/metering) and Phase D
(custom domains, orgs billing, BYO-account enterprise) are deferred and
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

### Demo claim - the trial-to-signed-up bridge

Demo mode stays, and composes with open sign-ups: an anonymous visitor
drives a `demo-<hex>` project, likes it, signs up - and **keeps it**.
Nothing today connects a demo to an account (demos self-erase after
`DEMO_TTL_HOURS`, 720h = 30 days on cloudflarebase.com), so Phase A adds a
claim flow:

- **The registry decides, never the string shape** - the principle that
  already governs grandfathered `--` ids extends to demos. Claiming
  inserts a registry row for the demo id under the claimer's org; from
  that moment the guard sees a registered project and requires ownership,
  so anonymous access to a claimed demo ENDS at the same instant it gains
  an owner. Unregistered demo-shaped ids keep today's anonymous behaviour.
- **Agents learn by push, not by shape**: the console fans out
  `PUT /internal/projects/:id/claim` (service-binding-only, the erase-route
  precedent) to both agents; each sets a durable `claimed` flag that lifts
  the demo caps and cancels the TTL erase (`expireDemoProject` re-checks
  the flag before destroying, the same belt-and-braces as its existing
  `DEMO_MODE` re-check, so a pending alarm can never delete a claimed
  project).
- **The id never changes**, so data, users, JWKS trust, live sockets, and
  integration snippets all survive the claim with zero copying. The
  display name is editable; the id was always immutable. Demo branches the
  visitor minted are just derived ids - claiming the root lets them be
  registered as ordinary branch rows via the existing `createBranch`.
- The dashboard offers the claim at the moment of highest intent: a
  "Keep this project" affordance on demo surfaces that routes through
  sign-up and lands back on the claimed project.
- **The claim route is the ONLY minter of demo-shaped registry rows**:
  ordinary project creation refuses `demo-` ids (a row inserted without
  the agent fan-out would leave the TTL armed under a registered project).
  Demo access is possession-based, so the claim is too: whoever holds the
  id and is signed in claims it, first-claim-wins by primary-key
  atomicity - the same trust model the demo itself has.

### What Phase A deliberately does NOT change

Self-hosted defaults (claimed console, no mail, no open registration -
orgs arrive there too, but only invitations can mint users), the agents'
hot paths, the db agent, unclaimed demo flows and caps, the CLI (its login
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
  the LiveShard precedent: requests on the wildcard route resolve the
  subdomain and `env.DISPATCH.get(subdomain)`, zero lookup, because **the
  script name IS the subdomain**. Unclaimed subdomain = no script = branded 404. Reserved names (`www`, `api`, `console`, `admin`, `docs`, `status`,
  `mail`, `cfbase`, ...) never dispatch.
- **Bindings**: `DISPATCH` (namespace `cfbase-apps`, `-preview` per env),
  `CF_ACCOUNT_ID` var, `CF_HOSTING_API_TOKEN` secret (Workers Scripts
  edit, scoped to the namespace operations), optional `SENTRY_DSN`. No
  registry access - subdomain claims go through the console, which owns
  the control plane, so no agent owns global state.
- **Erase fan-out**: `DELETE /internal/projects/:id` lists namespace
  scripts by the project-id **tag** every deploy stamps, deletes them,
  then destroys the DO. A new call in `deleteProject`, per the contract.

### Subdomain claims

Global namespace, so claims live in the control plane: new D1 table `app`
(`subdomain` PK, `project_id`, `created_at`). Charset
`/^[a-z0-9][a-z0-9-]{2,47}$/`, no `--` (the branch separator), reserved
list enforced at claim. First deploy claims; project delete releases.
**Branch deploys inherit the family claim**: a deploy from `<root>--<b>`
serves at `<app>--<b>.cfbase.dev` - preview environments per branch fall
out of the id scheme for free, the branches-design payoff repeating.

### The deploy flow

1. `cloudflarebase link` (new CLI command) signs in via the existing
   `/cli-auth` hand-off, picks/creates a project, claims an app subdomain,
   and writes `cloudflarebase.json` (`{ project, app, origin }`).
2. `cloudflarebase deploy` **branches on context**: `cloudflarebase.json`
   present → managed deploy; otherwise today's self-hosted wrangler path,
   unchanged. Managed deploy runs the build (respects the user's
   `wrangler.jsonc` `main`/`assets` via jsonc-parser, already a CLI dep;
   a bare assets directory deploys as an assets-only Worker), then
   multipart-uploads bundle + asset manifest to
   `POST /api/projects/<id>/hosting/apps/<app>/deploys` with the CLI
   bearer token - the ordinary guard path, now ownership-checked by
   Phase A.
3. The console proxies to the `HostingAgent`, which drives the Cloudflare
   API: asset upload session (manifest → wanted hashes → base64 uploads →
   completion token), then
   `PUT /dispatch/namespaces/<ns>/scripts/<subdomain>` with metadata:
   modules, assets token, **tags** (`project:<id>`), **limits** (fixed v1
   caps: 50ms CPU, 50 subrequests), and bindings - injected
   `PROJECT_ID` + `CLOUDFLAREBASE_URL` vars so the SDK works out of the
   box, plus user vars from `cloudflarebase.json`. Secrets:
   `cloudflarebase secret set <name>` PATCHes the script with
   `keep_bindings` so redeploys never drop them.
4. The response is the live URL. Deploy history lands in the DO; the
   dashboard's Hosting page lists apps, deploys, and the URL per branch.

### Guardrails from day one

- **Custom limits** on every script (CPU ms, subrequests) - fixed in B,
  plan-driven in C.
- **Outbound Worker** on the namespace from the first deploy: v1 is
  pass-through plus the project tag in its parameters, which is exactly
  what C's egress metering and policy blocking hook into without a
  redeploy of user scripts.
- **Hard fixed caps**: apps per project (2), deploys per day (50), bundle
  size (5 MB gzip), assets count/size within platform limits. Enforced in
  the HostingAgent; C replaces the constants with plan lookups.
- **No demo hosting.** Anonymous code execution is an abuse machine; demo
  projects get an upsell card, the deploy route answers 403 for demo ids.
- **Assets stay per-tenant**: identical-hash assets are shared within a
  namespace unless hashes are salted - we salt the manifest hashing with
  the project id so one tenant can never probe another's content by hash.

### Serving, DNS, TLS

The `cfbase.dev` zone (to register) carries a proxied wildcard
`*.cfbase.dev` route to `hosting-agent` in `env.production`. Universal SSL
covers exactly one wildcard level, which the flat `<app>.cfbase.dev` and
`<app>--<branch>.cfbase.dev` scheme respects by construction. Customer
custom domains are Phase D (Cloudflare for SaaS custom hostnames on the
same dispatch path).

### Local dev and e2e

Dynamic script upload has no local simulator. `HOSTING_STUB=true`
(env.local/test) makes the agent record deploys in DO state and the
dispatch path serve a fixed stub - the full CLI → console → agent contract
runs in Playwright without the Cloudflare API. Real upload/serve coverage
is a small opt-in spec against the `-preview` namespace (the `RUN_AI_E2E`
precedent), because preview has no `cfbase.dev` route and serving is only
verifiable where the wildcard exists.

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
