# Storage Agent — `@cloudflarebase/storage` (Cloudflarebase's fourth primitive)

> **Status: planned, not started.** This file is the executable summary; it is
> normative until `agents/storage/CLAUDE.md` exists, which then becomes
> authoritative for what actually shipped.

## Context

Auth, db, and hosting are live. Storage is the last of the four primitives a
Firebase replacement is judged on, and the one the console has been advertising
as "soon" in the sidebar and the project overview since the db agent shipped.

It is object storage on R2: buckets of files with per-bucket access modes
verified against auth-agent project JWTs, a browser in the console, and a thin
client SDK — the same shape as db, one layer down the stack.

Authoritative references: root `CLAUDE.md`, `docs/agent-contract.md`,
`agents/db/CLAUDE.md` (the shard-per-DO precedent this copies), and
`agents/hosting/CLAUDE.md` (the optional-binding precedent this copies).

## Locked decisions (user-approved)

1. **A separate agent**, `agents/storage`, not a fourth shard class inside the
   db agent. The deciding argument is not tidiness: R2 is an **account-level
   opt-in behind a dashboard checkout flow**, so an R2 binding on the db worker
   would make every `@cloudflarebase/db` install require an R2 subscription or
   fail its deploy — the `AUTH_EVENTS` trap of 2026-08-15, on the most critical
   worker in the system. Bytes streaming through the database worker is the
   second reason.
2. **One shared R2 bucket, key-prefixed per project.** Bindings are static
   config, so bucket-per-project would mean the S3 API with SigV4 and an
   account token the agent holds — an HTTP round trip where a binding call
   belongs, plus a credential every self-hoster must mint. Prefixing costs
   _per-tenant_ lifecycle rules and _per-tenant_ CORS — the bucket gets one
   account-level policy for all of them — and bucket-per-project stays the
   Phase-3 escape hatch if either is ever really needed.
3. **Demo projects get a read-only seeded bucket**, never anonymous writes.
   See "Demo storage" — it is synthetic and touches R2 not at all.
4. **Named "Storage"**: `agents/storage`, `@cloudflarebase/storage`, worker
   `storage-agent`, proxy prefix `storage`, classes `StorageAgent` /
   `StorageBucket`. Matches Firebase Cloud Storage, Supabase Storage, and the
   roadmap card it replaces.

## What the platform decides for us

Verified against current Cloudflare docs, 2026-08-15. Each of these is load
bearing — they are why the design looks the way it does.

| Fact                                                                       | Consequence                                                                                                                                                              |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R2 requires a dashboard checkout to add the subscription; no API, no flag  | The R2 binding is **optional and absent from the self-hosted top level**. `configured: false`, uploads 503 with setup steps. The hosting `DISPATCH` precedent, verbatim. |
| `wrangler` auto-provisions R2 buckets when `bucket_name` is omitted        | Once R2 is enabled, self-host setup is two lines in `wrangler.jsonc` — never a manual bucket-creation step in the docs                                                   |
| Worker request body caps at 100 MB (Free/Pro), 200 MB (Business)           | Large files need **chunked multipart**; the cap applies per part, so 4.995 TiB is reachable with no credentials at all                                                   |
| Presigned URLs need account-level S3 access keys                           | Direct-to-R2 is a **transport**, not a tier: available when credentials are configured, and the client protocol is identical without them                                |
| SigV4 presigning works in a Worker (`aws4fetch`, Workers-native)           | The mint endpoint is ours; no AWS SDK, no Node shims                                                                                                                     |
| `signQuery` signs only `host` — an unsigned `Content-Type` is rejected     | The browser adds one automatically for a `Blob` body, so presigned parts upload as raw bytes and the content type lives in the index instead                             |
| Browser → R2 direct needs bucket CORS, including `ExposeHeaders: [ETag]`   | Bucket-level config on a shared bucket, so `*` origins with the signature as the capability; without the exposed `ETag` the client cannot complete a multipart upload    |
| Multipart: 5 MiB min part, 10,000 parts, all but the last uniform          | The server dictates `partSize`; the client never picks it                                                                                                                |
| `resumeMultipartUpload()` checks nothing — not even that the upload exists | The wire uploadId is our own HMAC envelope binding project, bucket, key, and partSize; the raw R2 id is never a client-visible capability                                |
| Binding ↔ S3 uploadId interop is undocumented                              | An upload stays inside ONE API for its whole life — never create with the binding and finish over S3                                                                     |
| A Durable Object is 128 MB of memory and one thread at ~1k req/s           | **Bytes never touch a Durable Object.** The stateless worker streams to R2 and sends the DO a small metadata RPC                                                         |
| `get()` returns `customMetadata` alongside the body                        | `owner` lives in R2 custom metadata, so owner-mode reads authorize with **zero DO hops and one R2 op**                                                                   |
| R2 `list()` is prefix-ordered, 1000/page, no sort or filter, Class A       | The DO index is not duplication — it is the only way to sort, filter, count, or page a bucket                                                                            |
| `delete()` takes up to 1000 keys per call                                  | Project erase is a paginated drain loop, not a single request                                                                                                            |
| `cache.delete()` purges only the colo that ran it                          | Overwrite purge cannot be global, so the default `cacheControl` stays short — a long TTL is the bucket owner choosing slow overwrite visibility on purpose               |
| Existing agent proxies do `await request.arrayBuffer()`                    | File bytes must **not** go through `/api/projects/<id>/storage/*` — uploads use the `/agents/*` passthrough directly, like the db hot path                               |

## Architecture

| Class           | SDK                            | Instance name          | Owns                                                                                                                     |
| --------------- | ------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `StorageAgent`  | Agents SDK `Agent<Env, State>` | `<projectId>`          | bucket registry, access config, project byte/object totals, state sync (`rev`), signed-URL secret, demo TTL, erase drain |
| `StorageBucket` | plain `DurableObject`          | `<projectId>:<bucket>` | the object index (one row per key), listing and keyset paging, multipart upload records, per-bucket counters             |

`StorageBucket` is a plain DO for the same reason `DbCollection` is: it is
reachable by anonymous public traffic, and SDK state-sync frames would leak
operator data onto those sockets. `StorageAgent` stays on the Agents SDK
because the console consumes it with `AgentClient` exactly like the others.

**Routing.** The worker entrypoint takes `/agents/storage-agent/<pid>/buckets/<b>/objects/**`
itself — it is the byte path, and it calls R2 directly, dipping into the
`StorageBucket` stub only for the metadata RPC. Everything else goes through
`routeAgentRequest` to `StorageAgent`. `GET /health` and
`DELETE /internal/projects/:id` sit on the worker, service-binding-only.

**Naming and ports.** Worker `storage-agent` (`-local`/`-test`/`-preview`;
production pinned `storage-agent`), web service binding `STORAGE_AGENT`, R2
binding `BUCKET`. Dev :8791, e2e :8801. Deploy order becomes
**auth → db → storage → hosting → web** (storage's JWKS fetch binds `AUTH_AGENT`).

**No Analytics Engine binding.** R2 already meters itself and the index holds
the counters; adding an account-opt-in binding to an agent whose whole
degradation story is already about account opt-ins buys nothing.

## Key layout, and the invariant that protects it

```
p/<projectId>/<bucket>/<key>
```

Project id first, so the entire project is one `list({ prefix })` at erase
time. Bucket names are validated `^[a-z0-9][a-z0-9-]{1,62}$`, so the bucket
segment can never contain a slash and no key can escape into a sibling tenant.
User keys are normalized before storage: no leading or trailing `/`, no empty
segments, no `.` or `..` segments (R2 treats keys as opaque, but the console's
folder view uses `/` as a delimiter and would misrender them), no control
characters, and capped so the full prefixed key stays under R2's 1024-byte
ceiling.

> **Hard invariant: the shared bucket must never have `r2.dev` enabled or a
> custom domain attached.** Either one serves every tenant's keys to the
> public internet in one click. Serving happens exclusively through the worker,
> which is what enforces the prefix. This goes in `agents/storage/CLAUDE.md`
> as a standing rule, next to the WfP claims rule it rhymes with.

## The byte paths

All under `/agents/storage-agent/<pid>/buckets/<b>/`, all streaming, none of
them entering a Durable Object with a body attached. All declared
`access: public` in the manifest — the per-bucket mode is the real gate and the
worker enforces it, db's hot-path arrangement — so the guard passes them
through untouched for anonymous end users, and `security.api.spec.ts` pins
that anonymity.

- **`PUT objects/<key...>`** — body streamed to `BUCKET.put()` with
  `httpMetadata` from the request and `customMetadata` carrying `owner` and
  `project`. One metadata RPC to `StorageBucket` after the put lands.
- **`GET objects/<key...>`** — `BUCKET.get()` with `onlyIf` built from the
  request's conditional headers; honours `Range`; sets `ETag` and the bucket's
  `cacheControl`. Owner-mode authorization reads `customMetadata.owner` off the
  object already in hand.
- **`HEAD` / `DELETE objects/<key...>`** — as above; delete hits R2 first.
- **`GET objects?prefix=&delimiter=/&cursor=&sort=`** — served by the index, not
  by R2: keyset paging with a `range of total` readout, the convention every
  other operator list in the console follows.
- **`POST signed-urls`** `{ key, method, ttl }` → a URL carrying
  `?v=&exp=&sig=`, HMAC over `pid \0 bucket \0 key \0 method \0 exp`. Minting
  is body-addressed, deliberately not `objects/<key...>/signed-url`: a suffix
  route is ambiguous against an object whose key ends in `/signed-url`, and
  route grammar must never be reachable from user data. Verified in the worker
  with **zero DO hops**, which is what makes a private image work in a plain
  `<img src>`. The signing key is a manifest `secrets.generated` value — minted
  by `StorageAgent` on first start, overridable by env var — cached per isolate
  WITH its version; `v=` names the version that signed, and a verifier holding
  a different one refetches once before refusing, so rotation bites on the next
  request rather than at cache expiry. Rotating invalidates every outstanding
  URL — the intended revocation mechanism — and `ttl` is capped at 7 days so no
  URL outlives the decision to mint it by much.

Public objects are cached in `caches.default` keyed by URL. Signed URLs are
`Cache-Control: private` and never enter the shared cache. Writes and deletes
`cache.delete()` their key on the way out, but that purge is per-colo (see the
platform table), so the default `cacheControl` is `public, max-age=60`: remote
colos serve the old bytes for at most a minute, and a bucket raising the TTL
is trading overwrite visibility for read cost knowingly. The same arithmetic
bounds an access flip — a bucket going `public` → `owner` keeps serving from
colo caches for at most the old TTL plus the worker's config-cache window
(Access control below).

> **Hard invariant: the byte path never serves scriptable content inline.** On
> the managed service it shares the console's origin, so an attacker-uploaded
> HTML or SVG file rendered inline is stored XSS against every operator session
> on cloudflarebase.com. Every object response carries
> `X-Content-Type-Options: nosniff`; inline rendering is an **allowlist**
> (raster images, video, audio, `text/plain`, PDF) and everything else — HTML,
> SVG, XML above all — goes out `Content-Disposition: attachment`. Serve-time
> policy, not write-time, because presigned writes bypass write-time checks by
> design (trap 4).

## Upload: one client algorithm, three transports

A single `PUT` cannot carry a large file — the Workers request body cap is
100 MB on Free/Pro. So uploads escalate, and the escalation is chosen **by the
server from the declared size and the agent's configured capabilities**. The
developer never picks a mode and the SDK's loop never branches on one.

| Size / capability                   | Transport                                                                                                    | Cost                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| ≤ 100 MB                            | one `PUT` through the worker → `BUCKET.put()`                                                                | **1 Class A op**, one round trip, no credentials        |
| > 100 MB, no S3 credentials         | **proxied multipart**: parts `PUT` through the worker, `resumeMultipartUpload().uploadPart()` on the binding | N+2 Class A ops, bytes transit the worker               |
| > 100 MB, S3 credentials configured | **presigned multipart**: parts `PUT` straight to R2 from the client                                          | N+2 Class A ops, worker out of the byte path, resumable |

**Multipart is not the default for everything, deliberately.** A multipart
upload costs `CreateMultipartUpload` + N × `UploadPart` + `CompleteMultipartUpload`
Class A operations; a `PutObject` costs one. Making the 40 KB avatar — which is
what the overwhelming majority of real uploads are — pay three operations and
three round trips to share a code path with the 4 GB video is paying for
symmetry with the common case's latency and the customer's bill.

The control plane is the same for both multipart transports:

- `POST uploads` `{ key, contentType, size }` → `{ uploadId, partSize, mode }`
  where `mode` is `proxy` or `presigned`. `partSize` is **server-dictated** (R2
  requires every part but the last to be identical) and sized so 10,000 parts
  always cover the declared size. Quota is reserved here, from `size` — the
  one storage call that consults the parent (project byte total and the
  concurrent-multipart cap), affordable once per file and never per part. The `uploadId`
  on the wire is **our own HMAC envelope** over the R2 uploadId plus project,
  bucket, key, and `partSize`: `resumeMultipartUpload()` validates nothing, so
  the raw R2 id must never be the capability, and the envelope is what lets
  every part `PUT` verify statelessly — zero DO hops — while staying unable to
  cross into another tenant's upload.
- `POST uploads/<id>/parts` `{ from, count }` → for `presigned`, a batch of
  short-TTL presigned `PUT` URLs, minted in windows rather than 10,000 at once.
  Not called at all in `proxy` mode.
- Part upload: `PUT uploads/<id>/parts/<n>` at us, or the presigned URL at R2.
  Either way the client keeps `{ partNumber, etag }`.
- `POST uploads/<id>/complete` `{ parts }` → completion runs **inside whichever
  API created the upload** (binding or S3), because uploadId interop between
  the two is undocumented and an upload that starts on one must not finish on
  the other. The worker then `head()`s the object to verify the real size
  against the reservation, deletes and 413s if it overran, and commits the
  index row.
- `DELETE uploads/<id>` aborts and refunds the reservation. An alarm sweeps
  uploads idle over 24 h — R2 aborts them itself after 7 days, but the
  reservation is ours to release and incomplete parts bill as storage until
  then.

So presigning is a **transport swap under an unchanged protocol**, not a
separate feature with its own client path. Without credentials every size still
works; the bytes just take the slower road through us.

### The four presigned traps

Recorded now because each one fails at runtime with a message that names the
wrong cause:

1. **`Content-Type` breaks the signature.** `signQuery: true` signs only the
   `host` header, and `fetch(url, { method: 'PUT', body: file })` makes the
   browser add `Content-Type` from `blob.type` — which R2 then rejects as an
   unsigned header. The SDK uploads parts as raw bytes and the content type
   lives in the **index** instead. This costs nothing precisely because we never
   serve straight from R2: the worker sets the response content type from the
   index on the way out.
2. **CORS is required and lives on the bucket.** A browser PUT to
   `<account>.r2.cloudflarestorage.com` is cross-origin. On a shared bucket the
   allowed-origin list cannot be per tenant, so it is `*` for `PUT` — defensible
   because the presigned URL _is_ the credential, and a signature bound to one
   key for fifteen minutes grants nothing else.
3. **`ExposeHeaders: ["ETag"]`, or multipart cannot complete.** The client must
   read each part's `ETag` off the response to send it back at completion; a
   browser cannot see a response header that CORS has not exposed. Missing it
   fails at the last step of a long upload, which is the worst place to fail.
4. **Presigned writes bypass every server-side check.** Authorization happens
   at mint time (we only sign for a caller who may write that key), size is
   verified after the fact against the reservation, and the content-type
   allowlist becomes a serve-time concern rather than a write-time one.

Credentials are `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ACCOUNT_ID`,
all in `secrets.optional` — genuine secrets, unlike `SENTRY_DSN`, and scopable
to the single bucket. `aws4fetch` is a deliberate runtime dependency of the
agent, the `uuid` precedent.

## Index consistency

R2 is the source of truth for bytes; the index is derived. The two failure
shapes are not symmetric: a _phantom row_ (indexed, no object) is benign — a
`GET` 404s and prunes it — while an _orphan blob_ (stored, unindexed) is billed
forever and findable by nobody. **Deletes go to R2 first and the index after**,
so a delete crash can only leave the benign shape. **Writes also go to R2
first** — the row wants the put's real size and etag, and an index-first
"pending" row would cost a second RPC on every 40 KB single-shot upload —
which is the one place the bad shape can occur: a crash between the put
landing and the metadata RPC orphans the object. The RPC runs under
`waitUntil` with retries, and the reconcile alarm exists precisely because
that window cannot be closed from the write path.

A daily reconcile alarm walks the bucket's R2 prefix, adopts unindexed objects
and prunes phantom rows, so the index is self-healing rather than merely
careful. `POST /admin/buckets/:name/reconcile` runs it on demand. Adoption is
also what makes the index **rebuildable**: drop a bucket's rows and reconcile
regenerates them from the R2 walk — the escape hatch for index schema changes
and for any future resharding.

The parent↔child protocol is db's, unchanged: row first then push, monotonic
`configVersion` so a stale push cannot regress a child, debounced absolute
counters reported by the child as a heartbeat rather than a change
notification, and the hot path never consulting the parent.

## Access control

Per-bucket config, edited through `PUT /admin/buckets/:name` with db's
omitted-field-means-unchanged semantics:

```ts
{
  read: 'public' | 'auth' | 'owner',
  write: 'public' | 'auth' | 'owner',
  readPermission?: string,          // JWT `permissions` claim, `*` wildcard
  writePermission?: string,
  publicListing?: boolean,          // default false
  maxObjectBytes?: number,
  allowedContentTypes?: string[],   // the Firebase Storage Rules analogue
  cacheControl?: string
}
```

`publicListing` is deliberately separate from `read: 'public'`: serving an
avatar to anyone is not the same as letting anyone enumerate every avatar, and
collapsing the two is how object stores leak. JWT verification, JWKS caching,
and the 503-on-neither-binding degradation are copied from `agents/db/src/jwt.ts`
— a copy, not an import; the cross-project ban stands.

**The byte path reads this config from a per-isolate cache**, not from a DO:
the worker holds each bucket's access config for a short TTL (30 s), refreshed
from `StorageBucket` on miss, beside the JWKS and the signing key — three
caches, one policy. That cache is what every zero-hop claim in this document
is made of, and its price is stated rather than hidden: there is no push
channel to isolates, so a flip toward MORE restrictive access converges within
the TTL per isolate, not instantly, and the combined worst case with the
shared response cache is the arithmetic under "The byte paths". The parent
also folds a quota-exhausted flag into the pushed config when the project's
debounced totals cross a ceiling, which is how single-shot writes enforce the
project cap without ever consulting the parent.

## Demo storage

Demo projects get **one synthetic read-only bucket** that never touches R2 at
all. The sample files are a handful of small assets embedded in the worker
bundle; the index rows are generated, the bytes are served from the module.

Three things fall out of that, and they are why this shape won over both
alternatives. There is no anonymous write surface, so nobody parks phishing
images on a `cfbase` origin. There is no per-demo storage cost and no R2
cleanup for the TTL reaper to get wrong. And it works on the **self-hosted
default with no R2 subscription at all**, so a fresh install can open the
Storage page and see the product instead of a 503.

Writes, deletes, and bucket creation answer 403 with the upsell card, the
hosting precedent.

## Caps

Hard v1 constants in the agent, env-overridable, swapped for plan lookups in
Phase C alongside hosting's:

| Cap                   | Value                             |
| --------------------- | --------------------------------- |
| Buckets per project   | 5                                 |
| Objects per bucket    | 10,000                            |
| Bytes per project     | 1 GB                              |
| Single object         | 100 MB single PUT, 5 GB multipart |
| Concurrent multiparts | 10 per project                    |

The project ceiling is set against R2's 10 GB free tier: the managed service
must not let one tenant consume the whole account allowance.

Enforcement never leaves the hot path. `maxObjectBytes` and the single-PUT cap
are checked against the declared `Content-Length` before a byte streams and
re-verified from the put result at index time; the project-wide byte and
object ceilings ride the quota-exhausted flag in the pushed config (overshoot
bounded by the debounce window plus the config TTL — the same
eventual-enforcement bargain db's counters make), and multipart reserves
exactly at create time, where a parent hop is already paid.

## Erase

`DELETE /internal/projects/:id` wipes every `StorageBucket` index and then
drains `p/<pid>/` from R2 in `list` + `delete(1000)` cycles under alarms on
**`StorageAgent`**, self-destructing only when the prefix comes back empty.

The parent owns the drain rather than the children precisely because the key
layout puts the project id first: one prefix covers the whole project, so no
child needs to outlive its index to finish cleaning up. The console's
`deleteProject` gets its answer as soon as the metadata is gone and the drain
is durably scheduled; a drain that keeps failing is retried indefinitely and
reported to Sentry, because the failure mode is silent recurring billing.

The drain must also survive its project id being **re-minted mid-drain**:
`StorageAgent` is named `<projectId>`, so a re-created project revives the
SAME DO. An `erasing` flag in its storage — set while the erase route answers,
cleared only when the prefix comes back empty — refuses every write with 503
until then, because without it the drain and the new tenant interleave on one
prefix: the drain deletes fresh uploads, or exits early on a transient miss
and bequeaths the old tenant's bytes to the new one. The erase-then-re-mint
e2e spec polls the flag away before asserting emptiness.

## Platform changes outside the agent

- **Contract** (`docs/agent-contract.md`, `src/lib/agent-registry.ts`, and the
  CLI's schema copy): `durableObjects.scope` gains `perBucket`; `bindings`
  gains `r2: [{ binding, bucketName?, optional? }]`; `AppAgentEntry['binding']`
  gains `STORAGE_AGENT`.
- **Root**: `STORAGE_AGENT` service binding in all five environments; proxy
  routes under `src/routes/api/projects/[projectId]/storage/` for the JSON
  surfaces **only** (bytes go direct — a proxy route that buffers a 100 MB
  upload into a 128 MB isolate is a memory bomb); `src/lib/openapi/storage.ts`;
  DTO mirrors in `src/lib/agents.ts`; `npm run dev` gains :8791;
  `wrangler.e2e.jsonc` and the Playwright config gain :8801; `deploy:all` gains
  the storage step in order.
- **Console**: three pages — `/storage` (bucket rail + object browser with
  folder navigation, upload dropzone, preview pane, keyset paging, AlertDialog
  deletes), `/storage/access` (the plain-English access sentence, mirroring the
  db Access tab), `/storage/integration`. `peek: 2`. Storage leaves the
  `comingSoon` arrays in `[projectId]/+layout.svelte` and `[projectId]/+page.svelte`.
- **CLI**: one `AGENTS.storage` entry; everything else rides the manifest.
- **e2e**: `storage.api.spec.ts` (CRUD, access modes, multipart, signed URLs,
  caps, erase-then-re-mint), `storage.ui.spec.ts` (browser, upload, delete
  confirm, paging), plus key-traversal, cross-project-prefix, byte-path
  anonymity, and inline-serving-allowlist cases added to
  `security.api.spec.ts`.

Local dev and e2e declare the R2 bucket and run against miniflare's simulator,
so the dev loop is full fidelity — only the self-hosted top level omits it.

## Phases

**S1 — Substrate.** Scaffold from `agents/hosting` (the smallest agent),
manifest and contract deltas, root wiring, bucket registry and index schema,
single-shot `PUT`/`GET`/`HEAD`/`DELETE`/list, the erase drain, the
`configured: false` degradation, `storage.api.spec.ts`.

**S2 — Product.** Access modes, JWT verification, rules (size, content type,
permission keys), signed download URLs, **proxied multipart** (the
credential-free transport, which is what pins the upload protocol), quotas and
counters, reconcile, the three console pages, the synthetic demo bucket,
`storage.ui.spec.ts`.

**S2.5 — Presigned transport.** `aws4fetch`, the optional S3 credentials, the
batch part-URL mint, bucket CORS on the managed service, and the size
verification at completion. Deliberately after S2 and not folded into it: it
swaps a transport under a protocol S2 already froze, so it cannot be what
shapes that protocol. If it slips, large uploads still work.

**S3 — Package.** `dist`/`template`/fragment/`NOTICE`, `AssertStorageAgentEnv`
plus `bindings.test-d.ts`, the `./client` SDK subpath
(`storage.bucket('avatars').upload(file)` — Supabase's vocabulary, which users
already know — with automatic multipart above the threshold and progress
events), `agents/storage/CLAUDE.md`, root `CLAUDE.md` entries, publish.

## Non-goals for v1

Image transformations (the Images binding is Phase 3); uploads that resume
across a page reload (the server-side upload record already outlives the
session — it is the client's part bookkeeping that does not, so this is SDK
persistence work, not protocol work); TUS; **tenant-configurable** CORS (the
shared bucket gets one account-level policy in S2.5, and per-bucket policy is
one of the things a shared bucket cannot have); per-bucket custom domains;
live/realtime file events (the `LiveShard` engine would have to be copied out
of the db agent first); lifecycle and expiry rules; object versioning; R2 event
notifications; and cross-project copy.

## Open questions

- **Does the console's own upload UI use the `/agents/*` passthrough?** It
  should — it is same-origin and already behind the guard — but that path has
  only ever carried WebSocket upgrades and small JSON. Verify a 100 MB
  streaming `PUT` through it against a real stack before S1 closes, per the
  verify-don't-reason rule.
- **Should `StorageBucket` exist in S1 at all**, or should the index start on
  `StorageAgent` and shard later? Reconcile makes either answer cheap to
  revise — the index drops and rebuilds from the R2 walk, so resharding is a
  reconcile, not a migration. Leaning shard-now anyway: symmetry with db, and
  the multipart upload records want a home that is not the parent.
