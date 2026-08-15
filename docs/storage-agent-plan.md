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
   per-tenant lifecycle rules and bucket-level CORS; those are the Phase-3
   escape hatch, not the v1 default.
3. **Demo projects get a read-only seeded bucket**, never anonymous writes.
   See "Demo storage" — it is synthetic and touches R2 not at all.
4. **Named "Storage"**: `agents/storage`, `@cloudflarebase/storage`, worker
   `storage-agent`, proxy prefix `storage`, classes `StorageAgent` /
   `StorageBucket`. Matches Firebase Cloud Storage, Supabase Storage, and the
   roadmap card it replaces.

## What the platform decides for us

Verified against current Cloudflare docs, 2026-08-15. Each of these is load
bearing — they are why the design looks the way it does.

| Fact                                                                      | Consequence                                                                                                                                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R2 requires a dashboard checkout to add the subscription; no API, no flag | The R2 binding is **optional and absent from the self-hosted top level**. `configured: false`, uploads 503 with setup steps. The hosting `DISPATCH` precedent, verbatim. |
| `wrangler` auto-provisions R2 buckets when `bucket_name` is omitted       | Once R2 is enabled, self-host setup is two lines in `wrangler.jsonc` — never a manual bucket-creation step in the docs                                                   |
| Worker request body caps at 100 MB (Free/Pro), 200 MB (Business)          | Large files need **chunked multipart**; the cap applies per part, so 4.995 TiB is reachable with no credentials at all                                                   |
| Presigned URLs need account-level S3 access keys                          | Direct-to-R2 upload is a Phase-3 opt-in, never the default path                                                                                                          |
| A Durable Object is 128 MB of memory and one thread at ~1k req/s          | **Bytes never touch a Durable Object.** The stateless worker streams to R2 and sends the DO a small metadata RPC                                                         |
| `get()` returns `customMetadata` alongside the body                       | `owner` lives in R2 custom metadata, so owner-mode reads authorize with **zero DO hops and one R2 op**                                                                   |
| R2 `list()` is prefix-ordered, 1000/page, no sort or filter, Class A      | The DO index is not duplication — it is the only way to sort, filter, count, or page a bucket                                                                            |
| `delete()` takes up to 1000 keys per call                                 | Project erase is a paginated drain loop, not a single request                                                                                                            |
| Existing agent proxies do `await request.arrayBuffer()`                   | File bytes must **not** go through `/api/projects/<id>/storage/*` — uploads use the `/agents/*` passthrough directly, like the db hot path                               |

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
them entering a Durable Object with a body attached.

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
- **Multipart**, for anything over the request-body cap:
  - `POST uploads` `{ key, contentType, size }` → `createMultipartUpload`, the
    DO records the upload, response carries a **server-dictated `partSizeBytes`**
    (R2 requires every part but the last to be the same size, so the client may
    not choose it) sized so 10,000 parts always cover the declared size.
  - `PUT uploads/<id>/parts/<n>` → `resumeMultipartUpload(key, id).uploadPart()`,
    part etag and size recorded on the DO.
  - `POST uploads/<id>/complete` → the DO returns the ordered parts, the worker
    calls `.complete()`, the index row commits.
  - `DELETE uploads/<id>` aborts. An alarm aborts uploads idle over 24 h,
    because R2 bills incomplete parts.
- **`POST objects/<key...>/signed-url`** `{ method, ttl }` → a URL carrying
  `?exp=&sig=`, HMAC over `pid \0 bucket \0 key \0 method \0 exp`. Verified in
  the worker with **zero DO hops**, which is what makes a private image work in
  a plain `<img src>`. The key is generated by `StorageAgent` on first start
  and cached per isolate (contract rule 8; an env var may take ownership of it).
  Rotating it invalidates every outstanding URL — the intended revocation
  mechanism, and documented as such.

Public objects are cached in `caches.default` keyed by URL. Signed URLs are
`Cache-Control: private` and never enter the shared cache.

## Index consistency

R2 is the source of truth for bytes; the index is derived. **Writes go to R2
first and the index after; deletes go to R2 first and the index after.** Both
orders are chosen against the same failure: a crash between the two steps must
leave a _phantom row_ (indexed, no object — a `GET` 404s and prunes it) and
never an _orphan blob_ (stored, unindexed, billed forever, findable by nobody).

A daily reconcile alarm walks the bucket's R2 prefix, adopts unindexed objects
and prunes phantom rows, so the index is self-healing rather than merely
careful. `POST /admin/buckets/:name/reconcile` runs it on demand.

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
| Single object         | 100 MB direct, 5 GB via multipart |
| Concurrent multiparts | 10 per project                    |

The project ceiling is set against R2's 10 GB free tier: the managed service
must not let one tenant consume the whole account allowance.

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
  confirm, paging), plus key-traversal and cross-project-prefix cases added to
  `security.api.spec.ts`.

Local dev and e2e declare the R2 bucket and run against miniflare's simulator,
so the dev loop is full fidelity — only the self-hosted top level omits it.

## Phases

**S1 — Substrate.** Scaffold from `agents/hosting` (the smallest agent),
manifest and contract deltas, root wiring, bucket registry and index schema,
single-shot `PUT`/`GET`/`HEAD`/`DELETE`/list, the erase drain, the
`configured: false` degradation, `storage.api.spec.ts`.

**S2 — Product.** Access modes, JWT verification, rules (size, content type,
permission keys), signed URLs, multipart, quotas and counters, reconcile, the
three console pages, the synthetic demo bucket, `storage.ui.spec.ts`.

**S3 — Package.** `dist`/`template`/fragment/`NOTICE`, `AssertStorageAgentEnv`
plus `bindings.test-d.ts`, the `./client` SDK subpath
(`storage.bucket('avatars').upload(file)` — Supabase's vocabulary, which users
already know — with automatic multipart above the threshold and progress
events), `agents/storage/CLAUDE.md`, root `CLAUDE.md` entries, publish.

## Non-goals for v1

Image transformations (the Images binding is Phase 3), presigned direct-to-R2
upload, per-bucket custom domains, live/realtime file events (the `LiveShard`
engine would have to be copied out of the db agent first), resumable TUS
uploads, bucket-level CORS configuration, lifecycle and expiry rules, object
versioning, R2 event notifications, and cross-project copy.

## Open questions

- **Does the console's own upload UI use the `/agents/*` passthrough?** It
  should — it is same-origin and already behind the guard — but that path has
  only ever carried WebSocket upgrades and small JSON. Verify a 100 MB
  streaming `PUT` through it against a real stack before S1 closes, per the
  verify-don't-reason rule.
- **Should `StorageBucket` exist in S1 at all**, or should the index start on
  `StorageAgent` and shard later? Sharding later is a migration; sharding now
  costs a class nobody needs at 10,000 objects. Leaning shard-now for symmetry
  with db, but it is genuinely arguable.
- **Content-type sniffing on download.** Storing a caller-supplied
  `content-type` and echoing it makes the origin serve attacker-chosen MIME
  types. `X-Content-Type-Options: nosniff` always, and probably a
  `Content-Disposition: attachment` default for anything outside an allowlist
  of image and media types.
