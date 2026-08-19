# Storage Agent

Object storage on R2 (docs/storage-agent-plan.md; S1 shipped 2026-08-15, with
the access modes, JWT gate, and serve-time policy pulled forward from S2 -
security first). One `StorageAgent` Durable Object per project (bucket
registry, access config, totals, erase drain) plus one `StorageBucket` plain
DO per bucket (`<projectId>:<bucket>` - the object index: sorted keyset
paging, counts, owner scoping). **Bytes never enter a Durable Object**: the
worker entrypoint streams request bodies straight to R2 and dials the index
only for small metadata RPCs.

Also read [AGENTS.md](AGENTS.md). Published as `@cloudflarebase/storage`
(the Supabase distribution model; `files` ships `dist`, `template`, `NOTICE`,
and the manifest).

**`./admin` is the SERVER subpath** (`src/admin.ts`,
`docs/admin-sdk-design.md` 3): `createStorageAdmin()` over a `cfbs_` service
key - bucket configure/drop/list plus object put/get/list/delete. It targets
the **console origin, never an agent base** (a key is verified in the console
guard and does not work on `/agents/*`), and object bytes ride the console's
one STREAMING proxy, so `put` passes a stream through untouched. Four
behaviours worth knowing: it refuses to construct in a browser
(`typeof globalThis.document !== 'undefined'`); it computes `Content-Length`
from the body and DEMANDS an explicit `size` for a stream, because the agent
answers 411 without one; it refuses FORM content types (`text/plain`,
`multipart/form-data`, `x-www-form-urlencoded`) locally with a sentence
explaining why, since SvelteKit's CSRF check rejects those on a request with
no Origin - and a service key never sends one (default content type is
`application/octet-stream` for exactly that reason); and it discriminates
404s the way its db/auth siblings do (2026-08-18): only the agent's own
`no such object` answers `get() → null`, `no such bucket`/`no such project`
throw with that message (a typo'd bucket must never read as an empty
dataset), and any OTHER 404 - a pre-S2 console with no object proxy at all -
throws `StorageAgentTooOldError` instead of impersonating a missing object.
Pinned by `e2e/admin-sdk.api.spec.ts`.

**Signed download URLs** (`src/signing.ts`, shipped 2026-08-17 - S2's first
item): `POST /buckets/<b>/signed-urls` (and the `/admin` mirror the console
and service keys use) mints `?v=&exp=&sig=`, HMAC-SHA256 over
`pid \0 bucket \0 key \0 method \0 exp`. Supabase's vocabulary - `key` or
`keys[]`, `expiresIn` seconds (default 3600, capped 7 days) - because that is
what people already have in their fingers. Verified in the worker off the
secret carried in the cached access answer, so a private `<img src>` costs no
extra hop. GET and HEAD only. Four rules that are easy to get backwards:

- **Minting requires exactly what READING requires**, because a valid
  signature bypasses the read mode. `owner` buckets resolve ownership at mint
  with one `head()` per key, and serve-time skips the owner check - a signed
  request carries no token, so there is no subject to compare.
- **Mint reads the parent directly** (`bucketAccess(..., force)`), never the
  isolate cache. Signing from a stale entry signs with a RETIRED secret, and a
  seven-day URL that dies in 30 seconds is worse than no URL.
- **Mint builds on the ROUTED serving domain, else the request's origin.**
  Originally it was the request's origin unconditionally, because a serve
  domain can be SET without being routed - true in production until 2026-08-18
  (custom domain pending DNS) and still true in local/e2e, which name a host
  that resolves nowhere and reach the path through the `x-cfbase-host`
  stand-in. Those are two different facts, so they are now two vars:
  `STORAGE_SERVE_DOMAIN` is the Host this worker ANSWERS on, and
  `STORAGE_SERVE_DOMAIN_ROUTED="true"` is what licenses putting it in a URL
  (`publicServeOrigin`). Minting on it is also a security gain - the bytes
  leave the console's origin, where operator cookies live. The host is still
  not signed, so either spelling verifies and swapping it stays the caller's
  option. Pinned by `signing.unit.test.ts` (the routed branch, which no
  environment here can honestly stand up) and by the e2e case proving the
  unrouted stack serves on its domain and never names it.
- **Rotation is bounded-time revocation**, converging within the access-cache
  TTL. The version-mismatch refetch rescues NEW URLs against a stale isolate;
  an OLD URL matches the version that isolate still holds. To kill a URL
  instantly, delete the object.
- **That refetch is THROTTLED** (`mayRefetchForVersion`, 2026-08-19, issue
  #72). The version is checked before the signature and the expiry, so a
  forged request needs neither to reach the one cache bypass on an
  unauthenticated path - and the coordinator it bypasses to is a
  single-threaded DO. A flood of bogus versions was therefore one uncached
  parent hop per request, on a worker with no rate limiter, reachable on the
  public CDN host. Two gates, and **the second is the load-bearing one**:
  versions only increment, so a requested version at or below the held one is
  a retired secret or a forgery and is refused with no hop - but a forgery can
  name an arbitrarily HIGH version, so that gate alone bounds nothing. The
  5s per-bucket cooldown is what turns a flood into one hop per window.
  It counts FORCED refetches only, never ordinary cache refills: an isolate's
  first sight of a new version must still ask, because mint (console origin)
  and serve (cdn) are usually different isolates in different colos, and that
  is exactly the rotation case. `openEnvelope` shares the throttle - a part
  PUT's envelope version is equally caller-controlled. The MINT paths stay
  unthrottled on purpose (see above: signing off a stale entry signs with a
  retired secret) and are gated surfaces, so they are not the lever.

Pinned by `signing.unit.test.ts` and the S2 block of `e2e/storage.api.spec.ts`,
where every containment case proves the URL is live in the same test first.
The hop COUNT is not observable from e2e, so the decision is unit-pinned and
the e2e case pins the wire contract around it (forged versions fail closed, the
bucket serves normally after a burst).

**Folder listing** (shipped 2026-08-17): `?delimiter=/` on the object listing
returns only DIRECT children as objects and collapses the rest into
`{ prefix, objectCount }` folders. Keys stay flat strings - a folder is derived
at read time. Objects keep their keyset page; folders are a bounded `GROUP BY`
(they have no stable cursor, being derived) and report `foldersTruncated`
rather than silently dropping any. `/` is the only delimiter accepted.

**Multipart uploads** (shipped 2026-08-17): `POST uploads` → `PUT
uploads/<id>/parts/<n>` → `POST uploads/<id>/complete`, plus `DELETE
uploads/<id>`. Five things worth holding on to:

- **Part size is server-dictated.** R2 needs every part but the last to be
  identical, so a client that picks its own can build an upload that cannot
  complete. `resolvePartSize` floors at 8 MiB - and at the 5 GB ceiling the
  floor always wins (640 parts), so `MAX_PART_SIZE` is defensive, not
  reachable. Don't "simplify" the clamp away.
- **The wire `uploadId` is our signed envelope, never R2's id.**
  `resumeMultipartUpload()` validates NOTHING - not even that the upload
  exists - so the raw id must not be the capability. The envelope carries
  every fact a part PUT needs, which is what makes parts cost zero DO hops,
  and it is bound to one project/bucket/key/partSize so it cannot be steered
  at another tenant. Same secret as download URLs under a distinct context
  label (`upload` vs `url`), so neither can be forged from the other.
- **Part sizes are checked at the part, not at completion.** R2 only complains
  when you assemble, by which point the client has spent the whole upload.
- **Reservations are quota.** An in-flight upload has bytes in R2 that no
  index row counts, so `uploads.reservedBytes` folds into `getBucketAccess` -
  which is how single-shot PUTs see them too. Ten concurrent per project, or a
  tenant could park the whole allowance and complete nothing.
- **Create records AFTER R2, and aborts on refusal.** A refusal arriving after
  the R2 upload exists is cleaned up immediately rather than left to R2's
  7-day abort; the crash window is bounded by that same 7 days. The parent's
  hourly sweep then aborts anything older than 24h **by age, not idleness** -
  idleness would cost a parent hop per part.

## Hard invariants

- **The PRODUCTION bucket must never have r2.dev enabled or a custom domain
  attached.** Either one serves EVERY tenant's keys to the public internet in
  one click, bypassing access modes, owner checks, the inline allowlist (so an
  uploaded HTML file becomes stored XSS on a host we set no headers on), and
  the `erasing` flag. Serving happens exclusively through this worker, which is
  what enforces the `p/<projectId>/<bucket>/<key>` prefix - the ONLY tenant
  boundary inside the bucket. A dedicated serving hostname
  (cdn.cloudflarebase.com) is a WORKER route plus `STORAGE_SERVE_DOMAIN`, never
  a bucket-level domain.

  **`cfbase-storage-preview` is a deliberate exception** (2026-08-17, owner's
  call): it carries an r2.dev dev URL, on the reasoning that preview is a test
  environment. Recorded rather than left implicit, because the rule above is
  otherwise absolute and a future session would "fix" the account back. Two
  consequences to keep in view: preview no longer rehearses production's
  security shape, so a bypass that only the worker would have caught cannot be
  caught there; and anything uploaded to a preview tenant is public to anyone
  with the key. Do not extend this to production, and do not put real data in
  preview buckets.

- **The byte path never serves scriptable content inline.** On the managed
  service the agent path shares the console's origin, so attacker-uploaded
  HTML/SVG rendered inline is stored XSS against every operator session.
  Every object response carries `X-Content-Type-Options: nosniff`; inline
  rendering is an ALLOWLIST (raster images, video, audio, text/plain, PDF)
  and everything else goes out `Content-Disposition: attachment`. Serve-time
  policy, not write-time, because presigned writes (S2.5) bypass write-time
  checks by design.
- **Object keys are validated, never repaired** (`src/keys.ts`): no `.`/`..`
  segments, no empty segments, no leading/trailing `/`, no control
  characters, and the composed key stays under R2's 1024-byte ceiling. The
  worker builds every R2 key from schema-validated parts; nothing else in the
  system may write to the shared bucket. WHATWG URL resolves bare `%2e%2e`
  segments BEFORE any code runs, so normalization-then-classification has no
  gap (pinned by `route-access.unit.test.ts`).

## Architecture

- **Worker entrypoint** (`src/index.ts`): the byte paths
  `/agents/storage-agent/<pid>/buckets/<b>/objects[/<key...>]` (public by
  manifest - the per-bucket mode is the real gate) and the operator mirror
  under `/admin/buckets/<b>/objects...` (console-guard gated, modes
  bypassed - the Firestore Admin SDK model; the console's upload UI and the
  e2e suite ride it). Everything else goes through `routeAgentRequest` to
  `StorageAgent`. `/health` and service-binding-only
  `DELETE /internal/projects/:id` sit on the worker.
- **Per-bucket access config** lives on the parent; the worker reads it
  through `getBucketAccess` behind a ~30s per-isolate cache (5s for misses
  and erasing answers), so the hot path pays zero DO hops on cache hits and a
  flip toward MORE restrictive access converges within the TTL. The answer
  folds in the bucket counters and quota verdict, which is how single-shot
  writes enforce ceilings without a per-request parent hop - eventual
  enforcement, bounded by the child's 5s report debounce plus the cache TTL.
- **Access modes** `public | auth | owner` per bucket, read and write
  separately, defaulting to `auth` on BOTH (db's default - a fresh bucket is
  never anonymous). `publicListing` is a separate grant from `read: 'public'`
  (serving a known key ≠ enumerating every key; default false). Optional
  `readPermission`/`writePermission` keys check the JWT `permissions` claim
  (`*` wildcard; 403 for a valid token lacking the key, distinct from the
  tokenless 401). `owner` mode stamps the writer's JWT subject into R2
  `customMetadata.owner` and authorizes reads/deletes/overwrites off the
  object already in hand - not-yours answers exactly like not-there (404),
  except overwrite refusal which is 403. JWT verification is a COPY of
  agents/db/src/jwt.ts adapted to a per-isolate JWKS cache (the worker is
  stateless); neither `AUTH_AGENT` nor an `AuthAgent` namespace configured →
  token-gated buckets 503, public ones unaffected.
- **Index consistency**: R2 is authoritative for bytes; the index is derived.
  Writes AND deletes go to R2 first - a delete crash leaves a benign phantom
  row (a later GET prunes it), never an unindexed orphan that bills forever.
  The recordPut RPC is AWAITED (not waitUntil): until the reconcile alarm
  exists (S2), an index failure must be visible to the caller, not a silent
  orphan. `recordPut` returns fresh counters and the worker folds them into
  its cache so a burst cannot sail far past a ceiling.
- **Caching**: public-mode plain GETs ride `caches.default` keyed on
  origin+pathname (query strings can never mint fresh entries). Range and
  conditional requests bypass the cache (the key is a bare URL; a match would
  answer 200 where 304/206 is due). Writes and deletes purge the current
  colo's entries for both URL spellings (agent path + serving domain);
  `cache.delete` is per-colo by platform, so the default
  `public, max-age=60` bounds cross-colo staleness - a bucket raising
  `cacheControl` chooses slower overwrite visibility knowingly.
- **Erase** (`destroy()` on the parent): sets a durable `erasing` flag,
  destroys every bucket index, drops the registry, then drains `p/<pid>/`
  from R2 in list+delete(1000) cycles under `this.schedule` alarms - retried
  indefinitely (the failure mode is silent recurring billing) and clearing
  itself only when the prefix comes back empty. The flag makes every object
  path answer 503 meanwhile, because `StorageAgent` is named
  `<projectId>`: a re-minted id revives the SAME DO, and without the flag the
  drain and the new tenant would interleave on one prefix. Reads refuse too -
  the new tenant must never read the old tenant's bytes. Isolate caches may
  trust a stale config for up to their TTL after the erase starts; anything
  written in that window is deleted by the drain, which only terminates on an
  empty listing.
- **Caps** (hard v1, env-overridable: `STORAGE_MAX_BUCKETS`,
  `STORAGE_MAX_OBJECTS_PER_BUCKET`, `STORAGE_MAX_PROJECT_BYTES`): 5 buckets
  per project, 10k objects per bucket, 1 GB per project (against R2's 10 GB
  free tier), 100 MB single PUT (the Workers request-body cap; multipart is
  S2). Per-bucket `maxObjectBytes` can only lower the PUT ceiling.
  `Content-Length` is required (411) - a chunked body would have to be
  buffered, and a 100 MB buffer in a shared isolate is a memory bomb.
- **Demo projects get a READ-ONLY sample bucket, answered entirely by the
  worker** (S2, 2026-08-17): `demoRoute` in `src/index.ts` intercepts every
  demo-shaped id BEFORE any DO is dialled (bytes bundled in the worker, rows
  generated, timestamps fixed), serving overview/listing/object reads and
  answering every write or capability mint with `demoRefusal()` - anonymous
  object HOSTING is still a phishing machine, only curated reads are open.
  The per-handler demo checks further down are unreachable belts kept so a
  dispatch reorder cannot quietly open demo writes; they answer
  `demoRefusal()` too, so the copy cannot drift.
- **The self-hosted default has NO `BUCKET` binding** - R2 is an
  account-level opt-in behind a dashboard checkout (the AUTH_EVENTS lesson:
  a binding the account lacks fails the whole deploy). The agent reports
  `configured: false` and object requests answer 503 with the setup steps;
  bucket metadata still works. Local dev and e2e declare the binding against
  miniflare's R2 simulator - full fidelity.
- **`STORAGE_SERVE_DOMAIN`** (production: `cdn.cloudflarebase.com`, a Worker
  **custom domain** since 2026-08-18 - not a zone route, which creates no DNS
  and conflicts with a custom domain on the same hostname): GET/HEAD only at
  `/<pid>/<bucket>/<key>`, same pipeline and enforcement as the agent path.
  Read-only by design - writes stay on the agent surface where the console
  guard and CORS policy already apply. `STORAGE_SERVE_HOST_HEADER` (local/
  test only) honours `x-cfbase-host` in place of Host, because local workerd
  is dialled by port (the hosting stub idiom).

## Commands

| Command              | Purpose                                                           |
| -------------------- | ----------------------------------------------------------------- |
| `npx tsc --noEmit`   | Typecheck (also runs the `bindings.test-d.ts` contract negatives) |
| `npm run test:unit`  | Route gate, keys, signing/envelope, reconcile under node:test     |
| `npm run migrations` | Generate migrations after `src/db/schema.ts` edits, then inline   |
| `npx wrangler types` | Regenerate Worker types after binding changes                     |
| `npm run dev`        | env.local on :8791 (miniflare R2 simulator)                       |
| `npm run dev:test`   | env.test on :8801 (the e2e stack's port)                          |
| `npm run build`      | Emit `dist/` for the published package                            |

## Gotchas

- **Never call `ctx.storage.deleteAll()` (or `ctx.abort()`) from inside a
  scheduled callback.** The Agents SDK's alarm body keeps working after the
  callback returns - it deletes the consumed schedule row, then re-queries
  `cf_agents_schedules` to arm the next alarm - so dropping storage there
  kills the alarm with an uncaught `SqlError: no such table:
cf_agents_schedules`. Cloudflare then retries the alarm (each retry
  throwing at the same query), and because the throw escapes before the
  output gate opens it can roll the teardown's own deletes BACK, leaving
  `erasing` set forever - stranding the next tenant of a re-minted id on
  exactly the 503 the flag exists to prevent. `finishErase` therefore clears
  its state explicitly (registry rows, the flag, and `setState` back to
  `initialState` - the SDK persists `state`, which is what `deleteAll` was
  really buying). `StorageBucket.destroy()` still uses `deleteAll`: it is a
  plain DO reached by RPC, never from an alarm body.
- The entrypoint may only export handlers and DO classes; a value export
  fails at boot with `Incorrect type for map entry`. Type-only exports fine.
- Never pass `cors: true` to `routeAgentRequest`.
- Never hand-edit `src/migrations.ts` or `drizzle/`; run `npm run migrations`.
- Never name a file `src/env.ts` - it collides with `src/env.d.ts`.
- A plain DO cannot read its own name: the worker carries
  `{ projectId, bucket }` on every write RPC and `StorageBucket` stores it
  once, which is how the stats heartbeat dials the parent after hibernation.
- The local R2 simulator populates `object.range` on FULL `get()`s
  (production leaves it undefined) and materializes `suffix: undefined`
  beside offset/length on real range reads - so every plain GET answered 206
  with a NaN Content-Range. Serving gates the 206 on the REQUEST's Range
  header (a 206 is only ever a valid answer to one) and tests range fields by
  VALUE, never with `in`.
- The console origin's HTTP stack (SvelteKit rebuilds the URL before hooks
  run) COLLAPSES literal empty segments, so `a//b` arrives here as `a/b` -
  through that door only; this worker's own door refuses the raw spelling
  (`keys.unit.test.ts`). Benign by construction: every arriving segment is
  still validated and the tenant prefix is composed from validated parts.
  Both behaviors are pinned (`security.api.spec.ts`, `storage.api.spec.ts`).
- `wrangler dev` puts a SIMULATED EDGE CACHE in front of every dev worker's
  HTTP entry, honouring `Cache-Control: public` (`CF-Cache-Status: HIT`).
  Dialled directly it happens to share this worker's `caches.default`, so
  purges reach it; dialled through the web worker the entry lives in the WEB
  process where no storage-side purge can - which is why write-then-reread
  e2e assertions bust it with a throwaway query param. Production has this
  cache on NEITHER door: worker-route responses are not auto-edge-cached and
  service bindings bypass caches entirely. Cache purges are AWAITED on the
  write paths (not waitUntil) so the writer's own re-read never races them.
- The id schemas (`projectIdSchema`, `DEMO_PROJECT_PATTERN`) are deliberate
  copies mirrored across the console and all agents - keep them in sync.
- Deploy order is auth → db → storage → hosting → web (`deploy:all` encodes
  it): this worker's `AUTH_AGENT` service binding needs the auth worker to
  exist first.
