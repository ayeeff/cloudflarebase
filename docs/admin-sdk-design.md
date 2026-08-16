# The server-side service path

> **Drafted 2026-08-16, and reversed the same day.** The first draft of this
> document proposed a new `@cloudflarebase/admin` npm package — Firebase's
> `admin.firestore()/.auth()/.storage()`, Supabase's
> `createClient(url, serviceRoleKey)`. That was wrong, and the reasoning is
> worth keeping (§3): **the unified server surface already exists**, at the
> console, because that is where the key is verified. A package would have
> wrapped HTTP calls that are already unified and already generated into a
> reference, at the cost of a fourth artifact to version and keep in sync with
> copied DTOs.
>
> What is actually missing is smaller and more useful: three holes in the
> surface, and six routes missing from the generated reference.

## 1. The gap

SK1 shipped the credential. What a server can do with it is incomplete in
three places and invisible in a fourth.

- It cannot read a db **document** by id, at all (§5.1).
- It cannot create, read, or update a **user** (§5.2).
- It cannot read, write, or delete a storage **object** — the whole point of
  storage (§5.3).
- Six admin routes it *can* use are absent from the generated OpenAPI
  document, so nothing tells a developer they exist (§6). One of them is the
  table SQL endpoint — the escape hatch that gives tables the get-by-id
  collections lack. It works today and is undiscoverable.

## 2. The decision: no package

**The REST API is the service path.** A server holds one `cfbs_` key, points
at one origin, and calls `/api/projects/<id>/...`:

```ts
const cfb = (path, init) =>
  fetch(`${process.env.CFBASE_URL}/api/projects/${process.env.CFBASE_PROJECT}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${process.env.CFBASE_SERVICE_KEY}`, ...init?.headers }
  });

await cfb('/db/admin/collections/posts/documents/' + id);       // db
await cfb('/admin/users');                                       // auth
await cfb('/storage/admin/buckets/avatars/objects/' + key);      // storage
```

That is the whole client. It needs no install, no version, and no
synchronisation with four packages' DTOs.

What makes it a real service path rather than a shrug is the two things this
document actually builds: an admin surface with no holes in it (§5), and a
generated reference that describes all of it (§6).

## 3. Why not a package (the reversal)

The argument FOR one was ergonomics: `cfb.db.collection('posts').get(id)`
reads better than a fetch wrapper, and Firebase and Supabase both ship one.

Three things defeat it.

**The surface is already unified, and not by the SDK.** The key is verified in
the console guard (`isServiceKeySurface` matches only under
`/api/projects/<id>/`), and the request reaches each agent over a service
binding the console has already authorized. The agent workers never see a
`cfbs_` bearer and have no notion of one. One key, one origin, every
primitive — before any client code exists. A package would not be *creating*
the unified service path; it would be re-describing one.

**The reference is generated, and a hand-written SDK is not.** `src/lib/openapi/`
emits an OpenAPI 3.1 document per project from the same zod schemas the
routes validate with, served at `/api/projects/<id>/openapi.json` and rendered
by Scalar at `/dashboard/<id>/api`. It cannot drift from the routes. A
hand-written client can, and would — that is what "keep the copies
synchronized" already costs this repo four times over.

**It would have been a category error where it was first proposed.** SK2 in
`service-keys-design.md` scoped this as `@cloudflarebase/db/admin` plus a
storage twin. But a key does not work against `/agents/*` at all, so that
subpath would have shipped, inside the db package, a client that never calls
the db worker — versioned against an agent it does not talk to.

The *public* client is genuinely different and stays: a project JWT is
verified by the agent itself, which is why `createDbClient` documents working
against either the direct agent base or the console proxy base. That SDK earns
its place with live queries, socket multiplexing, and reconnect — real
behaviour, not a header.

If ergonomics later prove to be the thing holding adoption back, the cheap
answer is a generated client from the OpenAPI document, not a hand-maintained
one.

## 4. What a key reaches, and what describes it

| Service     | Reachable                                                                                          | In the reference           |
| ----------- | ---------------------------------------------------------------------------------------------------- | -------------------------- |
| **db**      | query, aggregate, configure/drop collections + tables, PUT/DELETE by id, table SQL, import/export, PITR, views, replication | 31 paths; 5 missing (§6)  |
| **auth**    | list users, list sessions, set role, delete user, delete session, roles, settings                  | all 7                      |
| **storage** | list buckets, configure/drop bucket — **objects are unreachable** (§5.3)                           | 2 paths; objects missing   |
| **hosting** | nothing, deliberately — deploy tokens own that blast radius                                        | n/a                        |

The proxy topology is not uniform, and that asymmetry is what produced §5.3.
`db/admin/[...path]` is a catch-all, so any db admin route the agent adds is
reachable with no console change at all. Auth's six admin routes are explicit
per-route files, and storage has exactly two. Nothing generic backs them up:
the only passthrough is `/agents/*` (plus WebSocket upgrades on the REST
base), and a service key does not work there.

## 5. The agent gaps

### 5.1 db collections cannot be read by id

`/admin/collections/:name/documents/:id` handles PUT and DELETE only. There is
no GET and no PATCH, and no way to emulate either: `compileQuery` turns every
`where.field` into a JSON path into the `data` blob, so `id` — a system column
— is unreachable by any query the DSL can express. Neither `DbCollection` nor
`DbTable` has an `adminGet` RPC to expose.

**Tables have an escape hatch; collections have none.** `POST
/admin/tables/:name/sql` takes no JWT (guarded upstream by the console, which
a service key satisfies) and its gate admits SELECT and DML, so
`SELECT * FROM posts WHERE id = ?1` works today — see §6, it is simply
undocumented.

Fix: `adminGet`/`adminPatch` RPCs on both children — tables too, for parity,
so a caller does not need two different idioms — routed as GET and PATCH on
the existing item paths. Operator-grade like their PUT siblings: modes,
validators, and permission keys bypassed. PATCH merges shallowly into `data`,
mirroring the public path.

### 5.2 auth cannot create a user

The auth agent's admin surface is a console's surface: it lists, re-roles, and
deletes. `createUser` — the most-used call in Firebase's Admin SDK — has no
equivalent, nor `getUser`, `updateUser`, or a password set.

There is no workaround. `POST /api/projects/<id>/auth/sign-up/email` is the
END-USER path: subject to the project's sign-up mode, it starts email
verification, and it is not admin-grade. Seeding accounts, migrating from
another provider, and provisioning a service account are all impossible today.

Fix: admin routes over Better Auth's own server API, which already has these
operations. `user.role` keeps its `input: false` guard — role changes stay on
`PUT /admin/users/:id/role`, so there is exactly one writer.

Auth has no catch-all proxy, so each new route needs its `+server.ts` beside
the existing six.

### 5.3 storage objects are unreachable by service key

The storage AGENT is complete: `/admin/buckets/:b/objects[/:key]` serves list,
GET, HEAD, PUT, and DELETE, modes bypassed, operator-grade. The console never
got a proxy route for it. `storage/admin/buckets/[bucketName]/+server.ts`
matches that path and nothing below it, so
`/api/projects/<id>/storage/admin/buckets/avatars/objects/logo.png` 404s at
the router — before the agent is ever consulted.

`isServiceKeySurface` admits `storage/**`, so the guard would allow it. There
is simply nothing there to serve it.

**Why nobody noticed**: both existing consumers reach objects through
`/agents/storage-agent/<pid>/admin/buckets/<b>/objects/...` — the console's
upload UI and the whole e2e suite (`e2e/helpers.ts`). That passthrough works
for a session and is refused for a service key, which only matches under
`/api/projects/<id>/`. Service keys are the first consumer that cannot use
it.

Fix is console-only: a `[...key]` proxy under
`storage/admin/buckets/[bucketName]/objects/`, streaming the body rather than
buffering it (the agent's whole design is that bytes never enter a DO, and a
proxy that buffers a 100 MB PUT reintroduces exactly the memory bomb the
`Content-Length` requirement exists to prevent). **Shipped and verified
against the live e2e stack**: PUT streamed, bytes read back byte-identical,
listing indexed, DELETE, then 404.

#### The CSRF wrinkle, still open

SvelteKit's CSRF check runs at the top of `internal_respond`, **before any
hook**, so the console guard never sees the request. It forbids
POST/PUT/PATCH/DELETE whenever the content type is form-shaped —
`text/plain`, `multipart/form-data`, `application/x-www-form-urlencoded` — and
a MISSING origin counts as cross-site (`!request_origin` forbids outright, so
no trusted-origins list can admit it).

A service key sends no Origin by design. So uploading `text/plain` — a `.txt`,
a `.csv`, a `.md` — answers 403 with `Cross-site PUT form submissions are
forbidden`, before the key is ever examined. Every other content type works;
`application/octet-stream` is the storage agent's own default.

It is also invisible in development: the whole block sits behind
`if (!__SVELTEKIT_DEV__)`, so `vite dev` never applies it. Only the built
worker does, which is why this surfaced in e2e and would not have surfaced by
hand.

Two ways out, and the choice is a security decision rather than a technical
one:

1. **Leave it, document it.** Servers send a real content type or
   `application/octet-stream`. Zero risk, but a wart on "just use fetch", and
   S2's proxied multipart uploads would hit the same wall.
2. **Turn `csrf.checkOrigin` off and re-implement the check in the guard**,
   where it can be credential-aware: apply SvelteKit's exact rule to ambient
   credentials (session cookies) and skip it for credentials a browser cannot
   attach cross-origin (`cfbs_`, `cfbd_`, OIDC bearers — `Authorization` is not
   CORS-safelisted, so those are structurally immune to CSRF). Correct, and
   app-wide blast radius: get it wrong and the console's whole API is CSRF-able,
   sign-in included. Not to be done casually or in passing.

## 6. The reference gaps

Present in the agents, absent from `src/lib/openapi/`:

- `/db/admin/collections/{name}/documents/{docId}` — the collection twin of
  `/db/admin/tables/{name}/rows/{rowId}`, which IS documented
- `/db/admin/tables/{name}/sql` — §5.1's escape hatch
- `/db/admin/settings`
- `/db/admin/views/{name}`
- `/db/admin/realtime`
- `/storage/admin/buckets/{bucket}/objects[/{key}]`

Cheap to close and worth more than any wrapper: these are the routes a server
uses, and today the generated reference denies six of them exist.

## 7. Throughput

Every admin route is a proxy hop into a coordinator Durable Object, where the
public paths are one hop to the shard. A hot server loop funnels through a
single DO at ~1k req/s.

Accepted and documented. `service-keys-design.md` §10.5 designs the
alternative — admitting the key on the public shard paths — and defers it:
that needs the AGENT to trust a header from the console's service binding, and
that trust channel is precisely what SK1 avoided introducing. Not worth
opening for a throughput problem nobody has yet. Where the caller *does* have
a user context (an SSR route relaying its visitor), the public paths with a
project JWT remain the better path, and the docs should say which is which.

## 8. Deploy ordering

**The new agent routes must be deployed before anything calls them.** An older
deployed agent answers GET on a document path with a 404 indistinguishable
from "no such document" — the `FOLLOWER_ID_PATTERN` and 48-char project-id
lesson, third occurrence. Conflating the two is data-loss-shaped: a caller
that reads "not found" and then writes overwrites a record that exists.

Deploy order stays auth → db → storage → hosting → web.

## 9. Phases

Ordered cheapest-and-largest-effect first: §5.3 is console-only and restores a
whole primitive, so it leads.

- **A1 — storage objects.** The missing `[...key]` proxy (§5.3). No agent
  change, no redeploy of anything but the web worker.
- **A2 — db collection get/patch.** `adminGet`/`adminPatch` on `DbCollection`
  and `DbTable`; GET/PATCH on the two item routes. Reachable through the
  existing catch-all with no console change.
- **A3 — auth user CRUD.** create/get/update/set-password admin routes, plus
  a proxy file each.
- **B — the reference.** Close the six gaps in §6, and add whatever A1–A3
  introduce.
- **C — the edges.** e2e driving the real flows against the live stack
  (positive controls first — the SK1 lesson), a Server tab snippet per agent
  showing the key in use, README, and the CLI's `key create --env-file`.

## 10. Non-goals

An npm package (§3). Hosting (§4). Realtime — `subscribe` needs a project JWT
for the gateway and a service key is deliberately not one; a server wanting
live data uses the public client with a JWT. Read-only key tiers (SK1
non-goal, unchanged). Codegen from declared table schemas.

## 11. Risks

1. **Blast radius is unchanged from SK1** and is not widened here. But
   completing the surface makes that reach practical, which is the point and
   also the hazard: the docs must keep saying, in these words, that a service
   key is admin-grade over the whole project's data.
2. **Admin semantics bypass validators and permission keys**, because
   operator surfaces do. Documenting these routes beside the public ones
   invites the assumption that they enforce alike. Say it per route, not in a
   footnote.
3. **Operator surfaces skip the document size check.** `adminPut` writes
   without `checkDocSize`, where the public path and `importDocs` both enforce
   it. Tolerable when a human in a dashboard was the only caller; a server in
   a loop is not that. Pre-existing — listed so adding `adminPatch` does not
   quietly extend it.
4. **Deploy ordering** (§8) — the third instance of this failure mode.
