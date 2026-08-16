# The Admin SDK — the server-side service path

> **Drafted 2026-08-16.** SK2 in `docs/service-keys-design.md`, widened: that
> phase was scoped as `@cloudflarebase/db/admin` plus "the storage twin". It
> is neither. The credential is verified at the CONSOLE, not at any agent, so
> the SDK is one package across every primitive — Firebase's
> `admin.firestore()/.auth()/.storage()`, Supabase's
> `createClient(url, serviceRoleKey)`.

## 1. The gap

SK1 shipped the credential. There is no client.

Today a server holding a `cfbs_` key writes hand-rolled `fetch` against
`/api/projects/<id>/admin/*`, guessing at bodies that are documented only by
the OpenAPI document. Worse, the shape of those routes is a *console's* shape
— `POST /admin/query` with `{collection, query}` in the body — not a
programmer's.

The product ships **one client SDK in total**: `@cloudflarebase/db/client`,
and it is the browser one. `@cloudflarebase/auth`, `@cloudflarebase/hosting`,
and `@cloudflarebase/storage` export only a worker entrypoint, a wrangler
fragment, and a manifest. There is no server-side story anywhere.

## 2. Shape

A new top-level npm project, beside `cli/` — **`@cloudflarebase/admin`**:

```ts
import { createAdminClient } from '@cloudflarebase/admin';

const cfb = createAdminClient({
  url: 'https://cloudflarebase.com',   // the CONSOLE origin, always
  projectId: 'acme-prod',
  key: process.env.CFBASE_SERVICE_KEY  // cfbs_...
});

await cfb.db.collection('posts').get(id);
await cfb.db.table('orders').query({ where: [{ field: 'status', op: '==', value: 'open' }] });
await cfb.auth.createUser({ email, password });
await cfb.storage.bucket('avatars').put(key, bytes);
```

One install, one key, one construction.

## 3. Why one package, and why NOT inside an agent

`@cloudflarebase/db/admin` looks like the obvious home. It is a category
error.

**A service key is console-origin-only.** `isServiceKeySurface` matches
exclusively under `/api/projects/<id>/`, the guard in `src/hooks.server.ts`
verifies it against control-plane D1, and the request then travels to the
agent over a SERVICE BINDING that the console has already authorized. The
agent workers never see a `cfbs_` bearer and have no notion of one. A key
does not work against `/agents/*` at all.

So a `@cloudflarebase/db/admin` subpath would ship, inside the db package, a
client that never calls the db worker — it calls the console. It would
version with an agent it does not talk to.

The *public* client is genuinely different and stays where it is: a project
JWT is verified by the agent itself, which is why `createDbClient` documents
working against either the direct agent base or the console proxy base.

The admin SDK is a client of the **console API**. It depends on no agent
package, copies its DTOs like everything else in this repo, and versions
against the deployment.

## 4. The surface, service by service

What a key opens today (`isServiceKeySurface`: `db/**`, `storage/**`, auth
`admin/**`, `/overview`, `/analytics`):

| Service     | Reachable today                                                                                                                                                            | Missing                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **db**      | query, aggregate, configure/drop collections + tables, PUT/DELETE by id, table SQL, import/export, PITR, views, replication status                                          | **collections: get by id, patch** (§5.1)              |
| **auth**    | list users, list sessions, set role, delete user, delete session, roles, settings                                                                                          | **createUser, getUser, updateUser, setPassword** (§5.2) |
| **storage** | list buckets, configure/drop bucket, list objects, GET/HEAD/PUT/DELETE by key                                                                                              | — complete                                             |
| **hosting** | nothing, deliberately                                                                                                                                                      | out of scope by design                                 |

Hosting stays out: deploying is what deploy tokens are for, and the two blast
radii stay separate (`service-keys-design.md` §3).

## 5. The gaps are AGENT changes, not SDK ones

### 5.1 db collections cannot be read by id

`/admin/collections/:name/documents/:id` handles PUT and DELETE only. There is
no GET and no PATCH, and no way to emulate either: `compileQuery` turns every
`where.field` into a JSON path into the `data` blob, so `id` — a system column
— is unreachable by any query the DSL can express. Neither `DbCollection` nor
`DbTable` has an `adminGet` RPC to expose.

**Tables already have an escape hatch and collections do not.** `POST
/admin/tables/:name/sql` takes no JWT (it is guarded upstream by the console,
which a service key satisfies) and its gate admits SELECT and DML, so
`SELECT * FROM posts WHERE id = ?1` and `UPDATE posts SET ... WHERE id = ?2`
work today. Collections have no raw-SQL surface by design.

Fix: `adminGet`/`adminPatch` RPCs on both children (tables too — parity, and
so the SDK is not two different shapes), routed as GET and PATCH on the
existing item paths. Operator-grade like their PUT siblings: modes,
validators, and permission keys bypassed. PATCH merges shallowly into `data`,
mirroring the public path's merge semantics.

### 5.2 auth cannot create a user

The auth agent's admin surface is a *console's* surface: it lists, re-roles,
and deletes. `admin.auth().createUser()` — the single most-used call in
Firebase's Admin SDK — has no equivalent, nor does `getUser`, `updateUser`, or
a password set.

There is no workaround. `POST /api/projects/<id>/auth/sign-up/email` is the
END-USER path: it is subject to the project's sign-up mode, it starts email
verification, and it is not admin-grade. Seeding accounts, migrating from
another provider, and provisioning a service account are all impossible today.

Fix: admin routes over Better Auth's own server API, which already has these
operations. `user.role` keeps its `input: false` guard — role changes stay on
the existing `PUT /admin/users/:id/role`, so there is exactly one writer.

## 6. Throughput: the admin routes are parent-mediated

Every admin route is a proxy hop into a coordinator Durable Object, where the
public paths are one hop to the shard. A hot server loop funnels through a
single DO at ~1k req/s.

v1 accepts this and documents it. `service-keys-design.md` §10.5 designs the
alternative — admitting the key on the public shard paths — and defers it:
that needs the AGENT to trust a header from the console's service binding, and
that trust channel is precisely what SK1 avoided introducing. A throughput
problem nobody has yet is not worth opening it for.

What the SDK should do meanwhile: document which calls are parent-mediated,
and prefer the public paths WITH a project JWT wherever the caller actually
has a user context (an SSR route relaying its visitor's identity does).

## 7. Deploy ordering

**The new agent routes must be deployed before the SDK calls them.** An older
deployed agent answers GET on a document path with a 404 that is
indistinguishable from "no such document" — the `FOLLOWER_ID_PATTERN` and
48-char project-id lesson, third occurrence.

Two mitigations, both required:

1. Ship the agent routes first, in their own release, and bump
   `@cloudflarebase/auth` and `@cloudflarebase/db` before the SDK publishes.
2. The SDK distinguishes them anyway: a 404 whose body is not the agent's
   `{ error: 'no such document' }` shape is reported as an
   agent-too-old error naming the required version, never as a missing record.
   A silent wrong answer here is a data-loss-shaped bug — a caller that reads
   "not found" and then writes will overwrite a record that exists.

Deploy order stays auth → db → storage → hosting → web.

## 8. Phases

- **A1 — db collection get/patch.** `adminGet`/`adminPatch` on `DbCollection`
  and `DbTable`, GET/PATCH on the two item routes.
- **A2 — auth user CRUD.** create/get/update/set-password admin routes.
- **B — the package.** `@cloudflarebase/admin`: `.db`, `.auth`, `.storage`,
  plus `.overview()` / `.analytics()`. Method names mirror
  `@cloudflarebase/db/client` wherever the operation is the same, so the two
  SDKs read alike.
- **C — the edges.** e2e driving the real SDK against the live stack (positive
  controls first — the SK1 lesson), Integration-tab snippets, README, and the
  CLI's `key create --env-file` from SK3.

## 9. Non-goals

Hosting (§4). Realtime — `subscribe` needs a project JWT for the gateway, and
a service key is deliberately not one; a server wanting live data uses the
public client with a JWT. Read-only key tiers (SK1 non-goal, unchanged).
Codegen from declared table schemas. Any per-collection or per-bucket scoping
— that is what project JWTs with permission keys already do.

## 10. Risks

1. **Blast radius is unchanged from SK1** and is not widened here: the SDK
   reaches exactly what the guard already admits. But it makes that reach
   *ergonomic*, which is the point and also the hazard — the docs must keep
   saying, in these words, that a service key is admin-grade over the whole
   project's data.
2. **Admin semantics bypass validators and permission keys**, because
   operator surfaces do. An SDK that looks like the public client will be
   assumed to enforce like it. Method-level documentation, not a footnote.
3. **Operator surfaces skip the document size check.** `adminPut` writes
   without `checkDocSize`, where the public path and `importDocs` both
   enforce it. That was tolerable when a human in a dashboard was the only
   caller; a server in a loop is not that. Pre-existing, worth closing, listed
   here so adding `adminPatch` does not quietly extend it.
4. **Deploy ordering** (§7) — the third instance of this failure mode.
5. **A fourth published package** to version, release, and keep in sync with
   copied DTOs. The release workflow already handles per-package version
   detection, so the cost is real but bounded.
