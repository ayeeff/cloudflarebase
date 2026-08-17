export interface CodeExample {
	id: string;
	label: string;
	lang: string;
	code: string;
}

/**
 * Ready-to-paste auth snippets targeting `url` (a project's auth base, e.g.
 * `https://host/api/projects/<id>/auth`). Shared by the dashboard's
 * Integration tab and the landing page's API section.
 */
export function buildIntegrationExamples(
	url: string,
	options: { serviceKey?: boolean } = {}
): CodeExample[] {
	// `url` is `<origin>/api/projects/<id>/auth`; the admin client is
	// constructed from the two parts, not the auth base.
	const parts = url.match(/^(.*)\/api\/projects\/([^/]+)\/auth$/);
	const origin = parts?.[1] ?? '';
	const projectId = parts?.[2] ?? '<project-id>';

	return [
		{
			id: 'js',
			label: 'JavaScript',
			lang: 'javascript',
			code: `const res = await fetch('${url}/sign-up/email', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name, email, password })
});

// Same-origin apps get a cookie; external clients use the bearer token:
const token = res.headers.get('set-auth-token');

await fetch('${url}/get-session', {
  headers: { authorization: \`Bearer \${token}\` }
});`
		},
		{
			id: 'ts',
			label: 'Better Auth client',
			lang: 'typescript',
			code: `import { createAuthClient } from 'better-auth/client';

const authClient = createAuthClient({
  baseURL: '${url}'
});

await authClient.signUp.email({ name, email, password });
const { data: session } = await authClient.getSession();`
		},
		{
			id: 'react',
			label: 'React',
			lang: 'tsx',
			code: `import { createAuthClient } from 'better-auth/react';

const { useSession, signIn } = createAuthClient({
  baseURL: '${url}'
});

export function Profile() {
  const { data: session, isPending } = useSession();
  if (isPending) return <p>Loading…</p>;
  if (!session) {
    return <button onClick={() => signIn.email({ email, password })}>Sign in</button>;
  }
  return <p>Signed in as {session.user.name}</p>;
}`
		},
		{
			id: 'svelte',
			label: 'Svelte',
			lang: 'svelte',
			code: `<script>
  import { createAuthClient } from 'better-auth/svelte';

  const authClient = createAuthClient({
    baseURL: '${url}'
  });
  const session = authClient.useSession();
</script>

{#if $session.data}
  <p>Signed in as {$session.data.user.name}</p>
{:else}
  <button onclick={() => authClient.signIn.email({ email, password })}>
    Sign in
  </button>
{/if}`
		},
		{
			id: 'python',
			label: 'Python',
			lang: 'python',
			code: `import requests

BASE = "${url}"

res = requests.post(f"{BASE}/sign-up/email", json={
    "name": "Jane Doe",
    "email": "jane@example.com",
    "password": "correct-horse-battery",
})
token = res.headers["set-auth-token"]

session = requests.get(
    f"{BASE}/get-session",
    headers={"Authorization": f"Bearer {token}"},
).json()`
		},
		{
			id: 'curl',
			label: 'cURL',
			lang: 'bash',
			code: `# -i prints headers; set-auth-token carries the bearer token
curl -i -X POST ${url}/sign-up/email \\
  -H 'content-type: application/json' \\
  -d '{"name":"Jane","email":"jane@example.com","password":"correct-horse-battery"}'

curl ${url}/get-session \\
  -H 'authorization: Bearer <token>'`
		},
		// Opt-in: the landing page renders these for a DEMO project, and the
		// guard refuses service keys on demo ids outright - advertising a
		// credential that cannot work there would be worse than silence.
		...(options.serviceKey
			? [
					{
						id: 'service-key',
						label: 'Service key',
						lang: 'typescript',
						code: `import { createAuthAdmin } from '@cloudflarebase/auth/admin';

// SERVER ONLY. A service key can read, create, re-role, and delete every
// account in this project. Mint one under Settings - it is shown once and is
// scoped to THIS project, not to sibling branches.
//
// Two guards make a leak fail loudly rather than silently: this client
// refuses to construct in a browser, and the API refuses ANY request carrying
// an Origin header. A key pasted into frontend code breaks at your desk
// instead of shipping inside a JS bundle.
const auth = createAuthAdmin({
	url: '${origin}',
	projectId: '${projectId}',
	key: process.env.CLOUDFLAREBASE_SERVICE_KEY
});

// Seed accounts, or migrate them off another provider: this bypasses the
// project's sign-up mode AND email verification, which the public
// sign-up route cannot do. emailVerified defaults to false - an account is
// not verified merely because an admin created it.
const user = await auth.createUser({
	email: 'jane@example.com',
	password: 'correct-horse-battery',
	name: 'Jane'
});
await auth.setRole(user.id, 'admin');

// Support flows and migrations: set a password with no emailed token. An
// account with no credential (social-only) gains one. Existing sessions are
// revoked unless you pass revokeSessions: false.
await auth.setPassword(user.id, 'a-new-password');

const { users } = await auth.listUsers({ limit: 50 });

// url, projectId, and key fall back to CLOUDFLAREBASE_URL /
// CLOUDFLAREBASE_PROJECT / CLOUDFLAREBASE_SERVICE_KEY, so on a server that
// already has them this is just createAuthAdmin(). Inside a Worker there is
// no global process - secrets arrive on env: createAuthAdmin({ env }).`
					}
				]
			: [])
	];
}

/**
 * Database snippets targeting `url` (a project's db base, e.g.
 * `https://host/api/projects/<id>/db`). Rendered beside the auth examples in
 * the landing page's API section.
 */
export function buildDbIntegrationExamples(url: string): CodeExample[] {
	return [
		{
			id: 'db-rest',
			label: 'REST',
			lang: 'javascript',
			code: `// Create a post (public collection: no token needed)
await fetch('${url}/collections/posts/documents', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ data: { title: 'Show HN: my launch', votes: 1 } })
});

// The front page: top 25 by votes
const { docs } = await (await fetch('${url}/collections/posts/query', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ orderBy: [{ field: 'votes', direction: 'desc' }], limit: 25 })
})).json();`
		},
		{
			id: 'db-sdk',
			label: 'Client SDK',
			lang: 'typescript',
			code: `import { createDbClient } from '@cloudflarebase/db/client';

const db = createDbClient({
  baseUrl: '${url}',
  // auth/owner collections: mint a project JWT from the auth agent
  getToken: async () =>
    (await (await fetch('${url.replace(/\/db$/, '/auth')}/token')).json()).token
});

const posts = db.collection('posts');
await posts.create({ title: 'Show HN: my launch', votes: 1 });

// The front page re-ranks itself on every vote, on every open screen.
const unsubscribe = posts.subscribe(
  { orderBy: [{ field: 'votes', direction: 'desc' }], limit: 25 },
  { onSnapshot: (docs) => render(docs), onChange: (change, docs) => render(docs) }
);`
		},
		{
			id: 'db-tables',
			label: 'SQL tables',
			lang: 'typescript',
			code: `import { createDbClient } from '@cloudflarebase/db/client';

const db = createDbClient({ baseUrl: '${url}', getToken });

// Typed rows on a declared schema - the same handle surface as collections.
const todos = db.table<{ title: string; done: boolean }>('todos');
await todos.create({ title: 'ship it', done: false });

// Tables have live queries too: typed rows, same frames, same socket.
todos.subscribe(
  { where: [{ field: 'done', op: '==', value: false }] },
  { onSnapshot: (rows) => render(rows), onChange: (change, rows) => render(rows) }
);`
		},
		{
			id: 'db-drizzle',
			label: 'Drizzle',
			lang: 'typescript',
			code: `import { drizzleTable } from '@cloudflarebase/db/drizzle';
import { desc } from 'drizzle-orm';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

// \`cloudflarebase schema generate\` emits this from your declared columns.
const todos = sqliteTable('todos', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  votes: integer('votes')
});

// Real SQL over the gated /tables/todos/sql endpoint - a project JWT is
// required; the gate keeps statements single-table and DDL-free.
const db = drizzleTable({ baseUrl: '${url}', table: 'todos', getToken });
await db.insert(todos).values({ id: '1', title: 'ship it' });
const top = await db.select().from(todos).orderBy(desc(todos.votes)).limit(10);`
		},
		{
			id: 'db-ws',
			label: 'Raw WebSocket',
			lang: 'javascript',
			code: `// No SDK: one socket per collection, subscriptions multiplexed by id
const ws = new WebSocket(
  'wss://YOUR_HOST/agents/db-agent/PROJECT_ID/collections/posts/subscribe'
);
ws.onopen = () => ws.send(JSON.stringify({
  type: 'subscribe', id: 'q1',
  query: { orderBy: [{ field: 'votes', direction: 'desc' }], limit: 25 }
}));
ws.onmessage = (event) => console.log(JSON.parse(event.data));
// -> { type: 'snapshot', ... } once, then
// -> { type: 'change', kind: 'added' | 'modified' | 'removed', ... }`
		}
	];
}
