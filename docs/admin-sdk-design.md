# The server-side service path

> **Drafted 2026-08-16; packaging settled over three passes (§3), all kept.**
> The first draft proposed a standalone `@cloudflarebase/admin`. The second
> concluded no package at all. What shipped is neither: **raw HTTP is the
> contract, and each agent package ships an `./admin` subpath over it.**
>
> The load-bearing fact behind all three is that a service key is verified in
> the CONSOLE guard, not by any agent — so the unified server surface already
> exists before a line of client code, and a standalone package would only
> re-describe it. What co-location adds is that a route and its client version
> together.
>
> Four holes were closed, not the three first counted: db read-by-id, auth user
> management, storage objects, and — found last and worst — **CSRF refusing the
> primary server path** (§5.4), plus six routes missing from the generated
> reference.

## 1. The gap

SK1 shipped the credential. What a server can do with it is incomplete in
three places and invisible in a fourth.

- It cannot read a db **document** by id, at all (§5.1).
- It cannot create, read, or update a **user** (§5.2).
- It cannot read, write, or delete a storage **object** — the whole point of
  storage (§5.3).
- Six admin routes it _can_ use are absent from the generated OpenAPI
  document, so nothing tells a developer they exist (§6). One of them is the
  table SQL endpoint — the escape hatch that gives tables the get-by-id
  collections lack. It works today and is undiscoverable.

## 2. The decision: raw HTTP is the contract, per-agent clients sit on top

**The REST API is the service path.** A server holds one `cfbs_` key, points
at one origin, and calls `/api/projects/<id>/...`:

```ts
const cfb = (path, init) =>
	fetch(
		`${process.env.CLOUDFLAREBASE_URL}/api/projects/${process.env.CLOUDFLAREBASE_PROJECT}${path}`,
		{
			...init,
			headers: {
				authorization: `Bearer ${process.env.CLOUDFLAREBASE_SERVICE_KEY}`,
				'content-type': 'application/json',
				...init?.headers
			}
		}
	);

await cfb('/db/admin/collections/posts/documents/' + id); // db
await cfb('/admin/users'); // auth
await cfb('/storage/admin/buckets/avatars/objects/' + key); // storage
```

The explicit `content-type` in that helper is not decoration — see §5.4.

That path is fully supported and fully documented, and everything below rests
on it: an admin surface with no holes in it (§5), and a generated reference
that describes all of it (§6).

But a contract is not ergonomics. On top of it, each agent package ships an
`./admin` subpath — `@cloudflarebase/db/admin`, `@cloudflarebase/auth/admin`,
`@cloudflarebase/storage/admin` — constructed from `CLOUDFLAREBASE_SERVICE_KEY`
and documented server-only:

```ts
import { createDbAdmin } from '@cloudflarebase/db/admin';

const db = createDbAdmin(); // url + project + key from the environment
await db.collection('posts').patch(id, { votes: 9 });
await db.table('orders').sql('SELECT * FROM orders WHERE id = ?', [id]);
```

## 3. Packaging, in three passes

Written twice and corrected once more. Both reversals are kept, because the
reasoning is the useful part.

**Pass 1 proposed a standalone `@cloudflarebase/admin`.** Wrong — §3.1.

**Pass 2 concluded no package at all.** Right about the API being the contract,
wrong to stop there: telling a developer to hand-roll a URL builder is not a
server story.

**Pass 3, shipped: per-agent `./admin` subpaths.** The §3.1 objection was that
such a subpath ships "a client that never calls the db worker." True, and it
does not matter:

- **`createDbClient` already does this.** The public client documents working
  against either the direct agent base or the console proxy base, so the db
  package already ships a client that can target the console. The admin twin
  targeting the console _only_ is a difference of degree.
- **The versioning argument runs the other way.** An admin client wraps the DB
  AGENT's admin routes, so co-locating it means a route and its client ship in
  the same version — the same drift-prevention property §3.1 credits the
  generated reference with. The console is the transport, not the subject.

A client also earns its place in a way a thin wrapper would not: it is the only
place the **agent-too-old check** can live (§8). An older deployed agent
answers a routing 404 indistinguishable from "no such document" to anything
reading a status code, and treating one as the other is data-loss-shaped.
`DbAgentTooOldError` / `AuthAgentTooOldError` inspect the body shape and say
which it was. Raw fetch cannot do that for you, and nobody writes it by hand.

Two more things the clients do that the raw path cannot:

- **Refuse to construct in a browser** (`typeof globalThis.document !== 'undefined'`).
  The guard's `Origin` refusal already fails a browser-bundled key on the first
  call, but "401 on everything" does not tell a developer they shipped an admin
  credential to a CDN. This says exactly that, at construction — and the error
  names the client they should have used instead.
- **Always set `content-type: application/json`**, which sounds trivial until
  §5.4: `fetch` defaults a string body to `text/plain`, and that used to be a 403. The storage client additionally refuses form content types before the
  request leaves, with the reason.

Config resolves most-explicit-first — option, then a passed `env`, then the
ambient process — matching the CLI's rule. `CLOUDFLAREBASE_SERVICE_KEY` is
canonical, since the sibling credential is already
`CLOUDFLAREBASE_DEPLOY_TOKEN`; `CFBASE_SERVICE_KEY` is accepted too, because it
matches the `cfbs_`/`cfbd_` prefixes and people write it. Inside a Worker there
is no global `process`, so `{ env }` is passed explicitly.

### 3.1 Why not a standalone package (pass 1)

The argument FOR one was ergonomics: `cfb.db.collection('posts').get(id)`
reads better than a fetch wrapper, and Firebase and Supabase both ship one.

Three things defeat it.

**The surface is already unified, and not by the SDK.** The key is verified in
the console guard (`isServiceKeySurface` matches only under
`/api/projects/<id>/`), and the request reaches each agent over a service
binding the console has already authorized. The agent workers never see a
`cfbs_` bearer and have no notion of one. One key, one origin, every
primitive — before any client code exists. A package would not be _creating_
the unified service path; it would be re-describing one.

**The reference is generated, and a hand-written SDK is not.** `src/lib/openapi/`
emits an OpenAPI 3.1 document per project from the same zod schemas the
routes validate with, served at `/api/projects/<id>/openapi.json` and rendered
by Scalar at `/dashboard/<id>/api`. It cannot drift from the routes. A
hand-written client can, and would — that is what "keep the copies
synchronized" already costs this repo four times over.

**~~It would have been a category error where it was first proposed.~~** This
third argument was WRONG and pass 3 reverses it. It ran: a key does not work
against `/agents/*`, so a `@cloudflarebase/db/admin` subpath would ship, inside
the db package, a client that never calls the db worker — versioned against an
agent it does not talk to. See §3: the public client already targets the
console proxy base too, and the versioning runs the other way, since the client
wraps that agent's own routes.

The first two arguments survive, and they are why there is no STANDALONE
package: a unified `@cloudflarebase/admin` would re-describe a surface the
console already unified, and it would be a fourth artifact to version. The
generated reference remains the source of truth about the routes; the clients
are ergonomics over it, kept thin and pinned by e2e that drives the real
exports.

The _public_ client is different again and stays: a project JWT is verified by
the agent itself, which is why `createDbClient` documents working against
either base. That SDK earns its place with live queries, socket multiplexing,
and reconnect — real behaviour, not a header.

## 4. What a key reaches, and what describes it

| Service     | Reachable                                                                                                                   | In the reference         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **db**      | query, aggregate, configure/drop collections + tables, PUT/DELETE by id, table SQL, import/export, PITR, views, replication | 31 paths; 5 missing (§6) |
| **auth**    | list users, list sessions, set role, delete user, delete session, roles, settings                                           | all 7                    |
| **storage** | list buckets, configure/drop bucket — **objects are unreachable** (§5.3)                                                    | 2 paths; objects missing |
| **hosting** | nothing, deliberately — deploy tokens own that blast radius                                                                 | n/a                      |

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

### 5.4 CSRF refused the primary server path

Found while verifying §5.3, and initially mis-scoped as a storage-only wart.
It was not.

SvelteKit's CSRF check runs at the top of `internal_respond`, **before any
hook**, so the console guard never saw the request. It forbids
POST/PUT/PATCH/DELETE whenever the content type is form-shaped —
`text/plain`, `multipart/form-data`, `application/x-www-form-urlencoded` — and
a MISSING origin counts as cross-site (`!request_origin` forbids outright, so
no trusted-origins list can admit it).

A service key sends no Origin by construction: the guard refuses the key if one
is present. And **`fetch` defaults a string body to `text/plain;charset=UTF-8`
— `JSON.stringify(...)` included**. So this, the most natural call a server can
write and the one this document's own §2 example showed, answered 403 before
the key was read:

```ts
await fetch(url, { method: 'POST', headers: { authorization }, body: JSON.stringify(body) });
```

Not an edge case, then — the primary documented path, failing with a message
about form submissions that names nothing a caller would recognise. Storage was
the more visible half only because there `text/plain` is legitimate CONTENT
rather than a forgotten header.

It is also invisible in development: the whole block sits behind
`if (!__SVELTEKIT_DEV__)`, so `vite dev` never applies it. Only the built worker
does, which is why e2e caught it and hand-testing would not have.

**Fix (shipped): `csrf.checkOrigin` is off and re-implemented credential-aware
as `csrfHandle` in `src/hooks.server.ts`**, first in the sequence to keep
SvelteKit's ordering guarantee. It applies SvelteKit's exact rule and skips it
in exactly one case: the request carries an `Authorization` header.

That relaxation is sound because CSRF depends on the browser supplying the
credential BY ITSELF. Cookies do; `Authorization` does not — a browser never
adds it, and a cross-origin fetch that sets one triggers a CORS preflight this
app does not answer for untrusted origins. A request carrying a bearer cannot
have been forged by a victim's browser, and an attacker who already knows the
bearer has no use for CSRF.

The two halves are pinned separately, because the relaxation is the dangerous
one: `service-keys.api.spec.ts` proves a bearer write with `text/plain` now
works (and that a `.txt` uploads), while `security.api.spec.ts` proves the
cookie case is untouched — foreign-origin AND origin-less form writes still
403 across all three content types, sign-in included, with a same-origin
control so the check cannot pass by breaking the console's own forms.

The origin-blanking in that spec is load-bearing, the same trap SK1 hit: the
`api` project injects `origin: baseURL` into every context, so omitting the
header tests the same-origin case and passes on nothing.

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
opening for a throughput problem nobody has yet. Where the caller _does_ have
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

- **A1 — storage objects. DONE.** The missing `[...key]` proxy (§5.3),
  streaming. No agent change.
- **A2 — db collection get/patch. DONE.** `adminGet`/`adminPatch` on
  `DbCollection` and `DbTable`; GET/PATCH on the two item routes. Reachable
  through the existing catch-all, which needed only a `PATCH` export —
  SvelteKit routes by exported method, so an unexported verb 405s before the
  agent is reached.
- **A3 — auth user CRUD. DONE.** create/get/update/set-password over
  `internalAdapter`, plus a proxy file each. `writePassword` is shared with the
  local-dev reset hatch so the social-only (link) branch cannot drift.
- **B — the reference. DONE.** The six gaps in §6, the verbs A1–A3 added, and
  the thing that turned out to matter most: a `serviceKey` security scheme.
  There was none, so the generated document — the artifact §3 leans the whole
  no-package decision on — never mentioned that server-side access exists.
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
