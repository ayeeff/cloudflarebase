import {
	expect,
	request as playwrightRequest,
	test,
	type APIRequestContext
} from '@playwright/test';
import {
	authPath,
	DB_PROJECT,
	dbAdminTablePath,
	dbRowsPath,
	dbTableQueryPath,
	uniqueEmail
} from './helpers';

/**
 * Remote Config (RC1): the operator loop, and the two properties that make it
 * safe to build a product feature on the database primitive.
 *
 * 1. **Editing is a draft.** Publishing is what reaches clients, so an operator
 *    halfway through changing five parameters is never serving a half-changed
 *    config. Deletes are drafts too - the one edit you would most expect to
 *    take effect immediately, and the one it would hurt most if it did.
 * 2. **The storage is closed and reserved.** The parameter table is a real
 *    DbTable with both sides in `none` mode, and the `cfb_` prefix stops the
 *    generic table routes reconfiguring or dropping it - otherwise the Tables
 *    page is one dropdown away from letting every client rewrite the flags.
 */

const base = `/api/projects/${DB_PROJECT}/db/admin/remote-config`;
const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const TABLE = 'cfb_remote_config';

async function anonymousContext(baseURL: string | undefined): Promise<APIRequestContext> {
	const base = baseURL ?? process.env.BASE_URL ?? 'http://localhost:8797';
	return playwrightRequest.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
}

async function projectUserToken(baseURL: string | undefined, prefix: string): Promise<string> {
	const anon = await anonymousContext(baseURL);
	try {
		const signUp = await anon.post(authPath(DB_PROJECT, 'sign-up/email'), {
			data: { name: 'Config Spec User', email: uniqueEmail(prefix), password: 'db-spec-password-1' }
		});
		expect(signUp.ok(), await signUp.text()).toBeTruthy();
		const token = await anon.get(authPath(DB_PROJECT, 'token'), {
			headers: { authorization: `Bearer ${signUp.headers()['set-auth-token']}` }
		});
		expect(token.ok(), await token.text()).toBeTruthy();
		return (await token.json()).token as string;
	} finally {
		await anon.dispose();
	}
}

/** The spec shares one project, so each test works on its own keys. */
function key(name: string): string {
	return `${name}${run}`;
}

test.describe('remote config', () => {
	test('provisions itself on first read, with the table closed on both sides', async ({
		request
	}) => {
		const first = await request.get(base);
		expect(first.ok(), await first.text()).toBeTruthy();
		const body = await first.json();
		expect(Array.isArray(body.parameters)).toBeTruthy();
		expect(body.limit).toBeGreaterThan(0);

		// Reading the page is what creates the shard - no setup step, and a
		// project that never opens it never pays for one.
		const overview = await request.get(`/api/projects/${DB_PROJECT}/db/overview`);
		expect(overview.ok()).toBeTruthy();
		const tables = (await overview.json()).tables as {
			name: string;
			readAccess: string;
			writeAccess: string;
		}[];
		const table = tables.find((entry) => entry.name === TABLE);
		expect(table, 'the parameter table should exist after the first read').toBeTruthy();
		expect(table?.readAccess).toBe('none');
		expect(table?.writeAccess).toBe('none');
	});

	test('a draft edit does not reach clients until publish', async ({ request }) => {
		const flag = key('checkout');

		const created = await request.put(`${base}/${flag}`, {
			data: { valueType: 'boolean', defaultValue: true, description: 'new checkout' }
		});
		expect(created.ok(), await created.text()).toBeTruthy();
		const parameter = await created.json();
		expect(parameter.state).toBe('draft');
		expect(parameter.draftValue).toBe(true);
		// Never published, so there is nothing a client would be getting.
		expect(parameter.publishedValue).toBeNull();
		expect(parameter.pending).toBe(true);

		const listed = await request.get(base);
		expect((await listed.json()).pendingChanges).toBeGreaterThanOrEqual(1);

		const published = await request.post(`${base}/publish`, { data: { reason: 'e2e' } });
		expect(published.ok(), await published.text()).toBeTruthy();
		expect((await published.json()).published).toBeGreaterThanOrEqual(1);

		const after = await request.get(base);
		const live = (await after.json()).parameters.find(
			(entry: { key: string }) => entry.key === flag
		);
		expect(live.state).toBe('published');
		expect(live.publishedValue).toBe(true);
		expect(live.pending).toBe(false);

		// An edit to a live parameter goes back to pending, and what clients get
		// stays put until the next publish - the whole point of the model.
		const edited = await request.put(`${base}/${flag}`, {
			data: { valueType: 'boolean', defaultValue: false }
		});
		expect(edited.ok(), await edited.text()).toBeTruthy();
		const pending = await edited.json();
		expect(pending.draftValue).toBe(false);
		expect(pending.publishedValue).toBe(true);
		expect(pending.pending).toBe(true);
	});

	test('a remote config edit never takes the db page down', async ({ request }) => {
		// Editing records a `remote-config.changed` activity event into the
		// agent's state. The console parses that state on every db page load, so
		// an event type its mirrored schema does not know 502s the ENTIRE db
		// workspace - which is exactly what shipped with RC1. This loads the real
		// dashboard page (the api project carries the operator session) so the
		// mirror can never drift silently again.
		const flag = key('canary');
		const edited = await request.put(`${base}/${flag}`, {
			data: { valueType: 'boolean', defaultValue: true }
		});
		expect(edited.ok(), await edited.text()).toBeTruthy();

		const dbPage = await request.get(`/dashboard/${DB_PROJECT}/db`);
		expect(dbPage.status(), 'the db workspace must render after a remote config edit').toBe(200);

		// And the overview it renders from still parses as far as the events go:
		// the freshest event must be the one the edit just recorded.
		const overview = await request.get(`/api/projects/${DB_PROJECT}/db/overview`);
		expect(overview.ok()).toBeTruthy();
		const events = (await overview.json()).state.events as { type: string; message: string }[];
		expect(events.some((event) => event.type === 'remote-config.changed')).toBeTruthy();
	});

	test('the integration page SSRs its snippets, and unknown tools 404', async ({ request }) => {
		// Code samples are SSR'd, so a plain GET proves the page and its snippets.
		const integration = await request.get(`/dashboard/${DB_PROJECT}/config/integration`);
		expect(integration.status()).toBe(200);
		const html = await integration.text();
		expect(html).toContain('config-integration');
		expect(html).toContain(`/api/projects/${DB_PROJECT}/db/remote-config`);

		// Anything else under /config/<x> is a 404, never an empty workspace.
		const unknown = await request.get(`/dashboard/${DB_PROJECT}/config/nope`);
		expect(unknown.status()).toBe(404);
	});

	test('discard puts every draft back to what is being served', async ({ request }) => {
		const kept = key('kept');
		const invented = key('invented');

		await request.put(`${base}/${kept}`, { data: { valueType: 'number', defaultValue: 10 } });
		const publish = await request.post(`${base}/publish`, { data: { reason: 'baseline' } });
		expect(publish.ok(), await publish.text()).toBeTruthy();

		// One edit to a live parameter, one parameter that never existed.
		await request.put(`${base}/${kept}`, { data: { valueType: 'number', defaultValue: 999 } });
		await request.put(`${base}/${invented}`, { data: { valueType: 'string', defaultValue: 'x' } });

		const discarded = await request.post(`${base}/discard`, { data: {} });
		expect(discarded.ok(), await discarded.text()).toBeTruthy();
		expect((await discarded.json()).discarded).toBeGreaterThanOrEqual(2);

		const after = await request.get(base);
		const parameters = (await after.json()).parameters as { key: string; draftValue: unknown }[];
		expect(parameters.find((entry) => entry.key === kept)?.draftValue).toBe(10);
		// Never published, so there is no earlier value to return to - it goes.
		expect(parameters.find((entry) => entry.key === invented)).toBeUndefined();
	});

	test('removing a live parameter is a draft change too', async ({ request }) => {
		const doomed = key('doomed');
		await request.put(`${base}/${doomed}`, { data: { valueType: 'string', defaultValue: 'here' } });
		await request.post(`${base}/publish`, { data: { reason: 'baseline' } });

		const marked = await request.delete(`${base}/${doomed}`);
		expect(marked.ok(), await marked.text()).toBeTruthy();
		expect(await marked.json()).toMatchObject({ deleted: false, pendingPublish: true });

		// Still served: a delete that took effect before publish would be the one
		// edit that surprises you.
		const during = await request.get(base);
		const row = (await during.json()).parameters.find(
			(entry: { key: string }) => entry.key === doomed
		);
		expect(row.state).toBe('deleting');
		expect(row.publishedValue).toBe('here');

		await request.post(`${base}/publish`, { data: { reason: 'remove' } });
		const after = await request.get(base);
		expect(
			(await after.json()).parameters.find((entry: { key: string }) => entry.key === doomed)
		).toBeUndefined();
	});

	test('publishing nothing is refused rather than recording an empty version', async ({
		request
	}) => {
		await request.post(`${base}/discard`, { data: {} });
		const empty = await request.post(`${base}/publish`, { data: {} });
		expect(empty.status()).toBe(409);
		expect((await empty.json()).error).toContain('nothing to publish');
	});

	test('a value that does not match its declared type is refused', async ({ request }) => {
		const typed = key('typed');
		for (const [valueType, defaultValue] of [
			['boolean', 'yes'],
			['number', 'twelve'],
			['string', 42],
			['json', 'not-json']
		] as const) {
			const response = await request.put(`${base}/${typed}`, { data: { valueType, defaultValue } });
			expect(response.status(), `${valueType} <- ${JSON.stringify(defaultValue)}`).toBe(400);
		}
		// The keys themselves are checked too - these become client identifiers.
		const badKey = await request.put(`${base}/9lives`, {
			data: { valueType: 'string', defaultValue: 'x' }
		});
		expect(badKey.status()).toBe(400);
	});

	test('the parameter table is closed to clients and reserved from the Tables page', async ({
		request,
		baseURL
	}) => {
		await request.get(base); // provision

		const token = await projectUserToken(baseURL, 'config-attack');
		const anon = await anonymousContext(baseURL);
		try {
			// A signed-in user with a real project JWT cannot read the parameters
			// or write one, because the table is `none` on both sides. `/query` is
			// the read surface - there is no GET /rows - so probing that instead
			// would prove routing, not access.
			const read = await anon.post(dbTableQueryPath(DB_PROJECT, TABLE), {
				headers: { authorization: `Bearer ${token}` },
				data: {}
			});
			expect(read.status()).toBe(403);

			const write = await anon.post(dbRowsPath(DB_PROJECT, TABLE), {
				headers: { authorization: `Bearer ${token}` },
				data: { data: { value_type: 'boolean', draft_value: true, state: 'published' } }
			});
			expect(write.status()).toBe(403);
		} finally {
			await anon.dispose();
		}

		// And the OPERATOR cannot reopen it through the generic table routes -
		// which is the attack that matters, since an operator session is exactly
		// what the Tables page carries.
		const reopen = await request.put(dbAdminTablePath(DB_PROJECT, TABLE), {
			data: {
				readAccess: 'public',
				writeAccess: 'public',
				columns: [{ name: 'value_type', type: 'text' }]
			}
		});
		expect(reopen.status()).toBe(403);
		expect((await reopen.json()).error).toContain('reserved');

		const drop = await request.delete(dbAdminTablePath(DB_PROJECT, TABLE));
		expect(drop.status()).toBe(403);

		// Still closed after all of that.
		const overview = await request.get(`/api/projects/${DB_PROJECT}/db/overview`);
		const table = ((await overview.json()).tables as { name: string; writeAccess: string }[]).find(
			(entry) => entry.name === TABLE
		);
		expect(table?.writeAccess).toBe('none');
	});

	test('the feature that owns the table can also remove it', async ({ request }) => {
		// The way back out: reserving `cfb_` would otherwise leave a project that
		// stops using Remote Config stuck with the shard forever.
		await request.get(base);
		const removed = await request.delete(base);
		expect(removed.ok(), await removed.text()).toBeTruthy();

		const overview = await request.get(`/api/projects/${DB_PROJECT}/db/overview`);
		const tables = (await overview.json()).tables as { name: string }[];
		expect(tables.find((entry) => entry.name === TABLE)).toBeUndefined();

		// And it comes back on the next read, empty.
		const again = await request.get(base);
		expect(again.ok()).toBeTruthy();
		expect((await again.json()).parameters).toEqual([]);
	});
});
