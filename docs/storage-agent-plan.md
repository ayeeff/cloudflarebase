# Storage Agent — `@cloudflarebase/storage` (Cloudflarebase's fourth primitive)

> **Status: S1 shipped 2026-08-15** — with S2's access modes, JWT
> verification, permission keys, and the serve-time inline allowlist pulled
> forward (security first: a substrate with anonymous-writable buckets was
> never going to ship). `agents/storage/CLAUDE.md` is now authoritative for
> what shipped; this file remains the plan of record for S2 — **designed in
> full 2026-08-15**: signed URLs, proxied multipart, reconcile, folder
> listing, the console pages, the demo bucket — plus S2.5 (presigned
> transport) and S3 (packaging/publish). Deltas from the plan:
> the byte path's config cache asks the PARENT (not the child) on miss — one
> answer carries config, counters, and the quota verdict; the index RPC on
> writes is awaited rather than waitUntil'd until reconcile exists; and a
> dedicated serving hostname landed early as a worker route
> (`STORAGE_SERVE_DOMAIN`, cdn.cloudflarebase.com — never a bucket-level
> domain).

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
- **`GET objects?prefix=&delimiter=&cursor=&limit=`** — served by the index,
  not by R2: keyset paging in key order with a `range of total` readout, the
  convention every other operator list in the console follows. `delimiter=/`
  collapses folders ("Folder listing" below).
- **`POST signed-urls`** `{ key, method, ttl }` → a URL carrying
  `?v=&exp=&sig=`, HMAC over `pid \0 bucket \0 key \0 method \0 exp`. Minting
  is body-addressed, deliberately not `objects/<key...>/signed-url`: a suffix
  route is ambiguous against an object whose key ends in `/signed-url`, and
  route grammar must never be reachable from user data. Verified in the worker
  with **zero DO hops**, which is what makes a private image work in a plain
  `<img src>`. **S2 signs GET and HEAD only**: a signed URL BYPASSES the
  bucket's read mode at serve time — that is its purpose — so minting requires
  exactly what reading requires, and `owner` mode verifies ownership AT MINT
  with one `head()`. Write capabilities stay out (Non-goals): uploads have a
  protocol, and S2.5's presigning is the direct-to-R2 path. The admin mirror
  mints too — the console's preview pane needs URLs for private buckets. The
  signature covers project, bucket, key, method, and expiry but NOT the host,
  so one URL verifies on the agent path and the serving domain alike; mint
  builds on `STORAGE_SERVE_DOMAIN` when configured. The signing secret is a
  manifest `secrets.generated` value — minted by `StorageAgent` on first
  start, overridable by env var — versioned, and delivered to the worker
  INSIDE the same cached parent answer the access check reads: one cache,
  zero extra hops. `v=` names the version that signed, and a verifier holding
  a different one refetches once before refusing, so rotation bites on the
  next request rather than at cache expiry. Rotating invalidates every
  outstanding URL — the intended revocation mechanism — and `ttl` is capped
  at 7 days so no URL outlives the decision to mint it by much. Signed
  responses go out `Cache-Control: private, no-store` and never enter the
  shared cache.

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

**Upload state lives on the parent, and the reservation IS the record** —
resolving S1's open lean toward the child the other way. The part hot path
never touches a Durable Object (the envelope makes it stateless), so the only
record traffic is create/complete/abort/sweep — once per FILE, never per part
— and create already pays the parent hop for facts only the parent holds: the
project byte total and the concurrent-upload count. Splitting reservation
(parent) from record (child) would double the create hops and leave the sweep
needing a cross-DO join; one `uploads` table on `StorageAgent` (id, bucket,
key, R2 uploadId, `partSize`, reserved bytes, content type, owner, createdAt)
is the whole thing. `getBucketAccess` folds the open reservations into its
quota verdict, so single-shot PUTs see them too.

The control plane is the same for both multipart transports:

- `POST uploads` `{ key, contentType, size }` → `{ uploadId, partSize, mode }`
  where `mode` is `proxy` or `presigned` — always `proxy` in S2; the field
  ships now so S2.5 never changes the client contract. The create runs the
  write-mode check and the write-time rules against DECLARED values
  (`contentType` vs `allowedContentTypes`, `size` vs `maxObjectBytes` and the
  5 GB multipart ceiling — which is where a `maxObjectBytes` above 100 MB
  becomes meaningful), counts open uploads against the concurrent cap, and
  reserves `size` against the project quota. `partSize` is
  **server-dictated** (R2 requires every part but the last to be identical):
  the declared size over 10,000 parts, rounded up to a MiB, clamped to
  [8 MiB, 95 MiB] — the floor keeps part counts sane above R2's 5 MiB
  minimum, the ceiling keeps a proxied part under the Workers body cap. The
  `uploadId` on the wire is **our own HMAC envelope** over the R2 uploadId
  plus project, bucket, key, `partSize`, declared size, the reservation id,
  and a 25-hour expiry — signed with the same generated secret as download
  URLs under a distinct context label (`upload` vs `url`: one secret, no
  cross-protocol forgery). `resumeMultipartUpload()` validates nothing, so
  the raw R2 id must never be the capability, and the envelope is what lets
  every part `PUT` verify statelessly — zero DO hops — while staying unable
  to cross into another tenant's upload. The expiry means a swept upload's
  parts die at the signature check instead of surfacing as an R2 error to
  interpret; and rotating the secret kills in-flight multiparts along with
  outstanding URLs — stated, not accidental: rotation is the revocation
  lever, and uploads are day-scale.
- `POST uploads/<id>/parts` `{ from, count }` → for `presigned`, a batch of
  short-TTL presigned `PUT` URLs, minted in windows rather than 10,000 at once.
  Not called at all in `proxy` mode.
- Part upload: `PUT uploads/<id>/parts/<n>` at us, or the presigned URL at R2.
  Either way the client keeps `{ partNumber, etag }`. Proxied parts require
  `Content-Length` (411, the single-PUT rule) and must declare exactly
  `partSize` bytes — except the final part (the envelope carries the declared
  size, so the worker knows which number is last) — so a malformed client
  fails at its first part, never at complete.
- `POST uploads/<id>/complete` `{ parts }` → completion runs **inside whichever
  API created the upload** (binding or S3), because uploadId interop between
  the two is undocumented and an upload that starts on one must not finish on
  the other. The worker then `head()`s the object to verify the real size
  against the reservation (an invariant check in proxy mode, the real
  enforcement for S2.5's presigned parts), deletes and 413s if it overran,
  commits the index row — the child's `recordPut`, awaited, the single-shot
  visibility contract — and settles the parent: the reservation drops and the
  registry counters take a provisional bump the child's next absolute
  heartbeat corrects.
- `DELETE uploads/<id>` aborts and refunds the reservation. The parent's
  sweep alarm aborts uploads older than 24 hours **by age, not idleness** —
  tracking idleness would cost a parent hop per part, age needs nothing, and
  24 h covers any single file on any real link. R2 aborts them itself after
  7 days, but the reservation is ours to release and incomplete parts bill as
  storage until then.

The whole control plane exists under the `/admin/buckets/<b>/…` mirror too —
modes bypassed, console-guard gated — because the console's own big-file
uploads use the SAME protocol ("Console pages" below). Create, complete, and
abort are small JSON and may ride the `/api` proxy; part `PUT`s never do (the
proxy buffers bodies — the memory bomb the byte paths already route around).

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
landing and the metadata RPC orphans the object. S1 shipped that RPC
**awaited, and it stays awaited even once reconcile exists** — a deliberate
override of this plan's original `waitUntil`: the caller learns "stored but
unindexed — retry" instead of silently diverging, and the returned counters
are what the worker folds into its cached quota view, so a burst cannot sail
past a ceiling inside one cache window. The price is one metadata RPC on a
path that already paid an R2 round trip. Reconcile is the CRASH backstop, not
the consistency mechanism.

The reconcile alarm lives on the **child** — `StorageBucket` owns the index
and its own R2 prefix — as a plain-DO `setAlarm`: armed lazily on the first
write, re-armed daily on fire, deleted by `destroy()`. The walk is a
streaming **merge join** of two key-ordered streams — R2 `list()` pages
(`include: ['httpMetadata', 'customMetadata']`) against the index scanned in
key order — so memory stays one page deep whatever the bucket holds. An R2
key with no row is adopted (size, etag, content type, owner, and uploaded-at
all come off the listing); a row with no R2 key is pruned. Both actions skip
anything younger than ONE HOUR, object or row, because a write landing
mid-walk reads as divergence to whichever stream was read first — the grace
window turns that race into a no-op. In-flight multipart uploads never appear
in `list()`, so the walk is blind to them by construction.
`POST /admin/buckets/:name/reconcile` runs the same walk on demand and
reports `{ adopted, pruned }`. Adoption is also what makes the index
**rebuildable**: drop a bucket's rows and reconcile regenerates them from the
R2 walk — the escape hatch for index schema changes and for any future
resharding. The merge join is pinned by unit tests, not e2e: an orphan cannot
be staged through any public surface, which is rather the point.

The parent↔child protocol is db's, unchanged: row first then push, monotonic
`configVersion` so a stale push cannot regress a child, debounced absolute
counters reported by the child as a heartbeat rather than a change
notification, and the hot path never consulting the parent.

## Folder listing

The console browser navigates folders, and folders are VIRTUAL — exactly as
R2 treats them: nothing is created or deleted, `/` is just a byte keys may
contain. `GET objects?delimiter=/` collapses keys under the requested
`prefix` into first-segment entries `{ name, objectCount, totalBytes }`,
interleaved lexicographically with the leaf objects, keyset-paged over the
COLLAPSED sequence — the cursor is the last emitted entry name, folder or
leaf. Implementation is a computed-segment `GROUP BY` in the child: no tree
tables, no new columns, acceptable outright because a bucket caps at 10k
rows. Listing stays **key order only** — a secondary sort (size, updated)
wants a composite cursor, no operator list in the console re-sorts either,
and the `sort=` parameter this plan once sketched is dropped.
`publicListing` governs the delimited form exactly as the flat one.

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
from `StorageAgent` on miss (the S1 delta: one parent answer carries config,
counters, quota verdict — and, in S2, the signing secret), beside the JWKS —
two caches, one policy. That cache is what every zero-hop claim in this document
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

Mechanically it is a WORKER concern, never a DO. S1 already refuses demo ids,
but does part of it inside `StorageAgent.onRequest` — which means addressing
the route provisions the object first. S2 moves the whole demo answer INTO
the worker, before any stub is dialled, so a demo visit costs storage nothing
at all: the guard's zero-cost demo rule, extended down the stack.
`src/demo.ts` holds a fixed manifest of a handful of small assets — a few
raster images, a text file, a PDF, every one inside the serve allowlist —
with bytes imported into the bundle and FIXED timestamps, so listings are
deterministic. The overview reports one bucket, `samples` (`read: public`,
`publicListing: true`); the flat and delimited listings are generated from
the manifest; GET/HEAD serve module bytes through the same response pipeline
as real objects (nosniff, allowlist, cache headers). The console's demo pages
render from REST alone — no `AgentClient` session, because the state socket
would dial the DO the demo path exists to avoid.

Writes, deletes, bucket admin, signed URLs, and uploads answer 403 with the
upsell card, the hosting precedent.

## Console pages

Routes are `[projectId]/storage/[[tool=storagetool]]` — the db convention: an
optional-param route with a matcher (`access`, `integration`; bare `/storage`
is Files), exact-match nav highlighting for free. The manifest's console
block turns real:

```json
"console": {
	"section": "Storage",
	"icon": "hard-drive",
	"peek": 2,
	"pages": [
		{ "path": "/storage", "title": "Files", "testId": "nav-storage", "icon": "folder-open" },
		{ "path": "/storage/access", "title": "Access", "testId": "nav-storage-access", "icon": "shield-check" },
		{ "path": "/storage/integration", "title": "Integration", "testId": "nav-storage-integration", "icon": "plug" }
	]
}
```

The registry emits the sidebar section the moment `pages` is non-empty — no
console code change for the nav. Storage leaves the `comingSoon` arrays in
`[projectId]/+layout.svelte` and `[projectId]/+page.svelte`, and the project
overview trades the roadmap card for a live agent card (buckets / objects /
bytes over the pinned Integration + Open row) fed by the `StorageAgentState`
the SDK already syncs.

**Files** is the table-editor shape (db's tables workspace, not the Miller
columns): a permanent bucket rail — bucket list with object counts, a
New-bucket dialog that states the `auth`/`auth` default in plain words —
beside a full-bleed browser. Breadcrumb path segments navigate the delimiter
listing; a toolbar carries Upload plus a drag-drop overlay; the entry table
is name (per-type icon), size, content type, updated. Folder rows descend;
object rows open a right-side preview sheet: a metadata block (key, size,
type, etag, owner, timestamps), an inline preview honouring the serve
allowlist (anything outside it shows a download action instead — the console
must not render what the byte path will not), copy-URL, mint-signed-URL with
a TTL picker on non-public buckets, and delete behind an AlertDialog. Paging
is `range of total` + Prev/Next over the index's keyset cursors with the
client-side cursor stack; the 5s poll re-reads the CURRENT page — the
operator-list convention, verbatim. Bulk select rides the same confirm.

Console uploads ride the ADMIN mirror through the `/agents/*` passthrough —
streaming, guard-gated, modes bypassed, the Firestore Admin model — with
per-file progress, escalating to the multipart protocol above 100 MB: the
exact protocol end-user SDKs get, no special console path to diverge. "New
folder" just seeds a key prefix for the next upload — folders are virtual and
nothing is created.

Degraded states, each honest: no buckets → the create hero; `configured:
false` → the R2 setup-steps card (hosting's 503 card precedent); `erasing` →
a wipe-in-progress notice; demo → read-only browsing of the synthetic bucket
with the upsell replacing every mutating control.

**Access** mirrors the db Access tab: one card per bucket rendering the
config as the live plain-English sentence, with the read/write mode selects,
the `publicListing` switch, permission-key inputs, `maxObjectBytes`,
`allowedContentTypes` chips, and `cacheControl` — saved through the
omitted-field-preserving `PUT`. Bucket DELETION lives here behind the
typed-name confirm: the rail creates, Access destroys — the table/collection
convention.

**Integration** follows the db integration tab: REST snippets against the
project's real base URL (upload, download, list, signed-URL mint), the caps
readout from `/overview`, and the SDK snippet
(`storage.bucket('avatars').upload(file)`) marked as arriving with S3's
`./client`.

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
- **Console**: the three pages and the sidebar/overview promotion, designed
  in full under "Console pages" above, plus the `storagetool` param matcher.
- **CLI**: one `AGENTS.storage` entry; everything else rides the manifest
  (S2's `secrets.generated` signing-secret entry included).
- **e2e** (S1 shipped the api spec and the security cases; S2 adds):
  multipart happy path, envelope tamper and cross-tenant reuse, the
  concurrent cap, and abort-refunds; signed-URL mint / anonymous fetch on a
  private bucket / expiry / tamper / rotation-invalidates; the on-demand
  reconcile shape; demo synthetic-bucket reads and write refusals; and
  `storage.ui.spec.ts` (create → upload → browse folders → preview → delete
  confirm → paging, the access sentence, demo read-only).

Local dev and e2e declare the R2 bucket and run against miniflare's simulator,
so the dev loop is full fidelity — only the self-hosted top level omits it.

## Phases

**S1 — Substrate. Shipped 2026-08-15**, plus the S2 pull-forwards (access
modes, JWT, permission keys, quotas and counters, the serve-time allowlist)
and two additions the plan lacked: the operator admin mirror
(`/admin/buckets/<b>/objects…`, modes bypassed, guard-gated) and the
`STORAGE_SERVE_DOMAIN` worker route. `agents/storage/CLAUDE.md` records the
as-built shape.

**S2 — Product.** What remains after the pull-forwards, in build order: the
generated signing secret + signed download URLs first (smallest, and the
multipart envelope wants the secret in place); **proxied multipart** (the
credential-free transport, which is what pins the upload protocol);
reconcile; folder listing; the console pages; the synthetic demo bucket
(moving the demo refusal out of the DO); `storage.ui.spec.ts`. Exit gates: a
~100 MB streaming `PUT` through the `/agents/*` passthrough verified against
a real stack (S1's open question, inherited — per the verify-don't-reason
rule), and the full suite green.

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

Image transformations (the Images binding is Phase 3); write-capability
signed URLs (uploads have a protocol, and S2.5's presigning is the
direct-to-R2 path); uploads that resume
across a page reload (the server-side upload record already outlives the
session — it is the client's part bookkeeping that does not, so this is SDK
persistence work, not protocol work); TUS; **tenant-configurable** CORS (the
shared bucket gets one account-level policy in S2.5, and per-bucket policy is
one of the things a shared bucket cannot have); per-bucket custom domains;
live/realtime file events (the `LiveShard` engine would have to be copied out
of the db agent first); lifecycle and expiry rules; object versioning; R2 event
notifications; and cross-project copy.

## Open questions

Both S1 questions closed:

- **Console upload path — resolved.** The console rides the operator admin
  mirror through the `/agents/*` passthrough (S1 built it); the 100 MB
  live-stack streaming verification moved into S2's exit gates rather than
  blocking S1.
- **`StorageBucket` in S1 — resolved: it shipped.** And the upload-record
  lean this question carried is now resolved the OTHER way — upload state
  lives on the parent, because the reservation is the record (see "Upload").

Still open for S2:

- **The demo sample set.** Which files ship in the bundle — they must be
  small (tens of KB total: they ride every worker deploy), inside the serve
  allowlist, and licence-clean (anything third-party gets a NOTICE entry).
