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

## Degradation

Workers for Platforms is a paid product. Without `CF_ACCOUNT_ID` +
`CF_HOSTING_API_TOKEN` + a dispatch namespace, deploys answer 503 and the rest
of the stack is unaffected. `HOSTING_DOMAIN` empty disables the serving path.

## Commands

```bash
npm run dev              # wrangler dev --env local, :8790
npm run typecheck
npm run test:unit        # route-access, tar, cloudflare
npm run deploy:outbound  # the outbound worker — needed before the agent
npm run migrations
```
