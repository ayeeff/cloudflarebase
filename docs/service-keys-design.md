# Service Keys — the credential a server can hold

> **Drafted 2026-08-16 — NOT implemented.** Normative for implementation when
> scheduled. Closes the gap named in the DX review: Cloudflarebase today is a
> **client-first** backend. The Firebase client-SDK story is complete; the
> Firebase Admin SDK story does not exist.

## 1. The gap

Three credentials exist, and none of them fits a server:

| Credential             | Held by                                    | Opens                                                     |
| ---------------------- | ------------------------------------------ | --------------------------------------------------------- |
| Project JWT            | your app's **end users**, after signing in | `auth`/`owner` shards, scoped by their role + permissions |
| Console session        | the operator (cookie, or CLI bearer)       | **everything, across every project in their orgs**        |
| Deploy token (`cfbd_`) | CI                                         | two hosting endpoints; cannot read or write one row       |

So a browser app whose users sign in works today and needs no API key **by
design** - the end user's own JWT is the credential. But SSR data fetching, a
seed script, a cron, a webhook handler, a queue consumer, an admin backoffice:
none of them has anything to authenticate with. The only credential that would
work is an operator session token, which is the whole account, sliding 30 days,
unscoped, and revocable only by signing out everywhere. That is not a thing to
put in an env var, and nothing in the product should suggest otherwise.

## 2. Shape

A **service key** is a non-human operator, scoped to ONE project.

```
cfbs_<64 hex>          shown once at mint, SHA-256 digest stored
```

The insight that makes this small: **the admin surface already exists.** Every
agent already serves mode-bypassing operator routes - db's `/admin/query`,
`/admin/tables/:name/sql`, `/admin/collections/:name/documents/:id`, storage's
`/admin/buckets/...`, auth's user/role admin - and they are already the
Firestore-Admin-SDK contract: access modes, validators, and permission keys do
not apply, because an operator surface is not a tenant. Today the only thing
that can reach them is a human session.

A service key is therefore **an authentication change, not an authorization
one**: no agent changes at all, no new bypass path, nothing new to get wrong
inside a Durable Object. The whole feature lives in the console guard, one D1
table, the console UI, and an SDK.

## 3. What a key opens, and what it must never open

Accepted (the DATA plane, for the key's project only):

- `/api/projects/<id>/db/**`
- `/api/projects/<id>/storage/**`
- `/api/projects/<id>/admin/**` (auth: users, sessions, roles, settings)

Refused, always - a plain 401, never a session:

- `/api/registry/**` - a key must never create, rename, or **delete** a
  project, its own included.
- `/api/console/**`, `/api/cli/**` - no minting other credentials, no touching
  operator accounts. A leaked key must not be able to grow itself.
- `/api/projects/<id>/hosting/**` - deploying is what deploy tokens are for,
  and the two blast radii stay separate on purpose.
- any other project id, including a sibling branch (§4).

The containment property: a service key can read and write **its project's
data**, and nothing else. It cannot escalate, cannot spread, and cannot
destroy the project it belongs to.

## 4. Scoped to one project - NOT to the family

Deploy tokens cover a root and its branches, because you deploy the same app
to all of them. Service keys deliberately do not: **for data, the branch IS
the isolation boundary**, and that is most of what branches are for. A preview
key that reached production rows would make branch isolation a lie.

One key, one registry row. Mint a second for the branch.

## 5. Verification, and the hot path

Deploy tokens are checked a few times a day; a service key is checked on every
request a backend makes. So the digest lookup is cached per isolate
(`digest -> { projectId, revokedAt }`, 30s), the pattern the ownership and
bucket-config caches already use.

**Revocation therefore converges within the TTL**, and that is the stated
bargain - the same one `getBucketAccess` makes. A key revoked because it
leaked keeps working for up to 30 seconds. If that is ever not good enough,
the answer is a revocation epoch on the project row, not a lookup per request.

`last_used_at` is written debounced (once per minute per key, `waitUntil`), so
the console can show "last used 4 minutes ago" before an operator revokes
something they are not sure about - without paying a D1 write per data
request.

## 6. A service key must not work from a browser

**A request carrying an `Origin` header is refused outright**, whatever the key.

Server-to-server fetches do not send `Origin`; browsers always do. So a key
pasted into frontend code fails immediately and locally, at the moment the
developer writes it - not silently in production with the key already in a JS
bundle on a CDN. No CORS headers are ever sent on a service-key response
either: there is no legitimate cross-origin use.

This is the single highest-value guard in the design, because the failure it
prevents is the one that actually happens.

## 7. Storage

Control-plane D1, beside `deploy_token`:

```
service_key(
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,        -- exact row, never a family
  name         TEXT NOT NULL,        -- operator-chosen label
  digest       TEXT NOT NULL UNIQUE, -- SHA-256 of the secret; the secret is never stored
  created_at   INTEGER NOT NULL,
  created_by   TEXT,                 -- operator user id, for the audit trail
  last_used_at INTEGER,
  revoked_at   INTEGER
)
```

Deleting a project deletes its keys with it (the registry fan-out).

## 8. Phases

- **SK1 — the credential.** D1 table, mint/list/revoke API + console card on
  the project Settings page (one-time reveal, typed-name confirm to revoke),
  guard acceptance, isolate cache, Origin refusal, docs. Usable immediately
  with plain `fetch` against the admin routes.
- **SK2 — the admin SDK.** `@cloudflarebase/db/admin` and the storage twin, so
  the ergonomics match the public client: `admin.collection('posts').create()`
  targets `/admin/collections/posts/documents/<id>`. This is what turns "there
  is a credential" into "the DX is good".
- **SK3 — CLI.** `cloudflarebase key create|list|revoke`, wrangler vocabulary,
  and `key create --env-file` writing straight into `.env.local`.

## 9. Non-goals

Read-only vs read-write tiers (an obvious SK2+ addition, deliberately not in
SK1 - one key kind, one story, and the tiers are easier to add than to
un-ship); per-collection or per-bucket scoping (that is what project JWTs with
permission keys already do); org-wide keys (the blast radius is the point of
the scoping); key rotation windows; IP allowlists; JWT-shaped keys with
embedded claims (a random opaque secret is revocable, a signed claim is not).

## 10. Risks

1. **Blast radius.** An admin-grade key is every row in the project. Accepted
   deliberately - it is what the server-side use cases need and what every
   comparable product ships - and bounded by: one project only, one-time
   reveal, `Origin` refusal, per-key revoke, last-used visibility, and no
   ability to escalate or self-replicate.
2. **It bypasses validators and permission keys**, because operator surfaces
   do. A service key writing a malformed document is not caught by rules-lite.
   That is the Admin-SDK contract and it must be stated in the docs in exactly
   those words, not softened.
3. **Revocation lag** (§5) - 30s, documented, with an escape hatch designed if
   it ever matters.
4. **Branch-scoping divergence** from deploy tokens will surprise people who
   learned the family rule there. The mint UI has to say "this key is for THIS
   branch" rather than assume.
5. **The admin routes were designed for a console**, not for throughput. They
   are parent-mediated (the coordinator DO) where the public paths are one-hop
   to the shard, so a hot server loop on `/admin/query` funnels through a
   single Durable Object. SK2's SDK should prefer the public paths WITH a
   project JWT wherever the caller does have a user context, and the docs
   should say which is which. If service-key throughput becomes real, the fix
   is admitting the key on the public shard paths - which needs the agent to
   trust a header from the console's service binding, and that trust channel
   is exactly what SK1 avoids introducing. Design it then, not now.
