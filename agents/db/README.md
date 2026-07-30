# @cloudflarebase/db

Firestore-style JSON documents with live queries, running on Cloudflare
Durable Objects - one isolated instance per collection. The database
primitive behind [Cloudflarebase](https://github.com/cloudflarebase/cloudflarebase).

```bash
npx @cloudflarebase/cli add db
```

The CLI installs this package, merges `template/wrangler-fragment.jsonc` into
your `wrangler.jsonc`, re-exports the Durable Object classes from your
entrypoint, and reruns `wrangler types`. Manual setup is the same three
steps; both templates ship in the package.

## What you get

- **Collections of JSON documents** - CRUD over REST, one Durable Object per
  collection, addressed as `/agents/db-agent/<projectId>/collections/<name>`.
- **Queries** - `where` (`==`, `!=`, `<`, `<=`, `>`, `>=`, `in`,
  `array-contains`), `orderBy`, `limit`, and keyset cursors.
- **Live queries** - subscribe to a filtered query over WebSocket and receive
  `added` / `modified` / `removed` deltas as writes happen. Subscriptions
  survive hibernation; you pay nothing while idle.
- **Access modes per collection** - `public`, `auth`, or `owner`, verified
  against `@cloudflarebase/auth` project JWTs. `owner` scopes every read and
  write to the token's subject.
- **A typed client** - `@cloudflarebase/db/client` wraps REST and the
  subscribe protocol with the same zod schemas the server validates with.

```ts
import { createDbClient } from '@cloudflarebase/db/client';

const db = createDbClient({
	baseUrl: 'https://your-worker.workers.dev/agents/db-agent/my-app',
	getToken: async () => (await fetch('/api/auth/token')).json().then((t) => t.token),
});

const posts = db.collection('posts');
await posts.create({ title: 'Show HN: I built a Firebase on Cloudflare', votes: 1 });
const top = await posts.query({ orderBy: [{ field: 'votes', direction: 'desc' }], limit: 25 });

// A Reddit-style front page that re-ranks itself on every vote.
const unsubscribe = posts.subscribe(
	{ orderBy: [{ field: 'votes', direction: 'desc' }], limit: 25 },
	{ onSnapshot: (docs) => render(docs), onChange: (change) => apply(change) },
);
```

## Bindings

Required: the `DbAgent` and `DbCollection` Durable Object bindings and the
`DB_EVENTS` Analytics Engine dataset (auto-creates on first write). Optional:
an `AUTH_AGENT` service binding for multi-worker deployments - in the normal
single-worker install, having `@cloudflarebase/auth` in the same Worker is
enough for token verification. No secret is required for a working deploy.

## Limits (per collection)

A collection is one Durable Object: 10 GB of SQLite, roughly 1k requests/s,
and its own pool of hibernated subscribers. Collections are unlimited and
fully independent - there are no cross-collection queries or transactions,
which is exactly what lets a project scale collection by collection.
Documents are capped at 128 KB of JSON; queries return at most 200 documents
per page. Comparisons are defined between same-typed values; a missing field
is indistinguishable from `null`.

## Requirements

`compatibility_date >= 2026-07-10`, `nodejs_compat` + `nodejs_als` flags, and
`new_sqlite_classes` migrations for both classes (the fragment declares
them).

## License

Apache-2.0. Cloudflarebase is an independent project, not affiliated with or
endorsed by Cloudflare, Inc. See NOTICE.
