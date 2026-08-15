<p align="center">
  <img src="static/brand/github-header.png" alt="Cloudflarebase" width="100%" />
</p>

<p align="center">
  <a href="https://cloudflarebase.com/dashboard"><strong>Live demo</strong></a> ·
  <a href="#deploy-your-own">Deploy your own</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" /></a>
  <a href="../../actions/workflows/quality.yaml"><img alt="Quality" src="../../actions/workflows/quality.yaml/badge.svg" /></a>
  <a href="../../actions/workflows/e2e.yaml"><img alt="E2E" src="../../actions/workflows/e2e.yaml/badge.svg" /></a>
</p>

The open-source Firebase for Cloudflare - it runs entirely on your own
account. Each project gets isolated Durable Objects - Better Auth on embedded
SQLite, and a database with two models and live queries on both: Firestore-style
JSON documents and typed-column SQL tables you can drive with an ORM. Every
collection and table is its own DO with per-region read replicas out of the box,
NDJSON export/import, and 30-day point-in-time rollback - plus a dashboard with
live counters, analytics, an AI copilot, and a generated API reference.

Auth and Database are live. Storage, functions, and the rest will follow the
same agent shape.

## Run it locally

```bash
git clone https://github.com/cloudflarebase/cloudflarebase.git
cd cloudflarebase
npm install
npm run dev
```

Open <http://localhost:5173/dashboard>. There are no secrets to set up. Local
dev runs in demo mode, so you get a throwaway project without signing in.

## Deploy your own

One command from a clone deploys the whole stack - both agents, then the
dashboard, in dependency order:

```bash
git clone https://github.com/cloudflarebase/cloudflarebase.git
cd cloudflarebase
npm install
npx wrangler login
npm run deploy:all
```

That's three Workers on your account (`auth-agent`, `db-agent`,
`cloudflarebase`), a D1 control plane provisioned automatically, and nothing
to configure. The order matters - the db worker binds the auth worker, the
dashboard binds both - and `deploy:all` encodes it so you don't have to.

Auth-event analytics are off until you ask for them. Analytics Engine is an
account-level toggle only the Cloudflare dashboard can grant - no API, no
Wrangler flag - and a Worker that declares the binding will not deploy at all
until it is on (`no_access_to_analytics_engine`, code 10089). Rather than make
every install click through that first, the shipped config omits it: enable
Analytics Engine when you want the charts, then add the two lines
`agents/auth/wrangler.jsonc` shows you.

Then claim the console. Set a setup token from the same terminal - it needs
your Cloudflare credentials, which is the point:

```bash
npx wrangler secret put CONSOLE_SETUP_TOKEN   # 24+ characters
```

Open the dashboard, enter that token, and create the owner account.

Prefer not to clone? The Deploy to Cloudflare buttons do one Worker per
click, in the same order:

1. Auth agent: [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflarebase/cloudflarebase/tree/main/agents/auth)
2. DB agent: [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflarebase/cloudflarebase/tree/main/agents/db)
3. Dashboard: [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflarebase/cloudflarebase)

Then claim the console the same way: `wrangler secret put CONSOLE_SETUP_TOKEN`
on the dashboard Worker, enter it, create the owner account. Sign-up closes
behind that account and your install is private by default.

The token exists because your URL is not a secret. Without it, ownership of a
fresh install goes to whoever loads `/login` first - and a workers.dev name is
guessable. An unclaimed console stays inert until someone proves they deployed
it. The same token later reclaims a console whose owner you are not.

A deployment trusts its own origin automatically, so sign-in works right
after deploy with nothing to configure. If you serve the console from another
domain or call the API from other apps, add those origins to
`TRUSTED_ORIGINS` (the CSRF allowlist) or per project under Settings.

Optional extras, all off until configured: Google/GitHub sign-in, email
delivery, Sentry, and analytics SQL reads (`CF_ACCOUNT_ID` +
`CF_ANALYTICS_API_TOKEN` with Account Analytics Read).

## Add the agents to a Worker you already have

The console is optional. Each agent is a normal npm package, and the CLI
wires it into an existing Worker project - one `add` per primitive:

```bash
npm install -g @cloudflarebase/cli

cloudflarebase init my-backend   # scaffolds a Worker with auth
cd my-backend
cloudflarebase add db            # documents + SQL tables, live queries on both
npx wrangler login
cloudflarebase deploy            # sign-in and live queries work right away
```

In an existing project, `cloudflarebase add auth` and `cloudflarebase add db`
do the same individually. `add` merges the agent's wrangler config into yours
without overwriting anything you set, exports the Durable Object classes from
your entrypoint, and adds a type assertion so a missing binding fails at
compile time with its name.

## Use it from your app

The API is Better Auth, so its client works as-is:

```ts
import { createAuthClient } from 'better-auth/client';

const authClient = createAuthClient({
	baseURL: 'https://your-dashboard.workers.dev/api/projects/my-app/auth'
});

await authClient.signUp.email({ name, email, password });
```

Browsers get a cookie; everything else uses the `set-auth-token` bearer token.
Add your app's origin under the project's Settings tab first.

The database is one typed client with two models - JSON documents and typed
SQL rows - and live queries on both.

**Documents** need no schema; a collection exists the moment you write to it:

```ts
import { createDbClient } from '@cloudflarebase/db/client';

const db = createDbClient({
	baseUrl: 'https://your-dashboard.workers.dev/api/projects/my-app/db'
});

const posts = db.collection('posts');
await posts.create({ title: 'Hello', votes: 1 });

const front = await posts.query({
	orderBy: [{ field: 'votes', direction: 'desc' }],
	limit: 25
});
```

**Tables** are schema-first: declare typed columns once (the dashboard's table
designer, or `cloudflarebase schema apply` from a `cloudflarebase.schema.jsonc`
after `cloudflarebase login`), then the same handle surface returns typed rows:

```ts
const todos = db.table<{ title: string; done: boolean }>('todos');
await todos.create({ title: 'Ship it', done: false });
```

Prefer a real ORM? `cloudflarebase schema generate` emits the drizzle schema
from your declared columns, and `@cloudflarebase/db/drizzle` runs actual SQL
over the gated single-table endpoint (DDL-free, JWT-required):

```ts
import { drizzleTable } from '@cloudflarebase/db/drizzle';
import { desc } from 'drizzle-orm';
import { todos } from './cloudflarebase.schema'; // emitted by schema generate

const sql = drizzleTable({ baseUrl, table: 'todos', getToken });
const open = await sql.select().from(todos).orderBy(desc(todos.created_at));
```

**Realtime** is a `subscribe` on any collection or table query: a snapshot
first, then added/modified/removed deltas pushed as writes happen - windowed
queries handle displacement correctly. The SDK multiplexes every subscription
in the client over one WebSocket to a gateway in the subscriber's region:

```ts
posts.subscribe(
	{ orderBy: [{ field: 'votes', direction: 'desc' }], limit: 25 },
	{
		onSnapshot: (docs) => render(docs),
		onChange: (change, docs) => render(docs)
	}
);

todos.subscribe(
	{ where: [{ field: 'done', op: '==', value: false }] },
	{ onSnapshot: (rows) => render(rows), onChange: (change, rows) => render(rows) }
);
```

Reads are served from a replica in the reader's region (writes stay on the
shard's primary, and session bookmarks keep read-your-writes); every collection
and table can be exported, imported, and rolled back to any point in the past
30 days from the dashboard.

Each project also serves an OpenAPI 3.1 document at
`/api/projects/<id>/openapi.json`, rendered in the dashboard under API
Reference.

## Checks

```bash
npm run check   # svelte-check
npm run lint    # prettier + eslint
npm test        # Playwright against real workerd
```

## Security

Report vulnerabilities privately via [SECURITY.md](SECURITY.md). Keep
`DEMO_MODE` unset anywhere real users live.

## License

[Apache-2.0](LICENSE). Cloudflarebase is an independent project, not
affiliated with or endorsed by Cloudflare, Inc. See [NOTICE](NOTICE).
