import {
	expect,
	request as playwrightRequest,
	test,
	type APIRequestContext
} from '@playwright/test';
import {
	authPath,
	DB_PROJECT,
	dbAdminQueryPath,
	dbAdminTablePath,
	dbAdminTableRowPath,
	dbAdminCollectionPath,
	dbRowPath,
	dbRowsPath,
	dbTableExportPath,
	dbTableQueryPath,
	uniqueEmail
} from './helpers';

/**
 * SQL tables through the dashboard proxy: schema-first declaration, typed
 * CRUD with schema enforcement, additive-vs-destructive alters, unique
 * columns, typed queries with json-column dotted paths, owner isolation, and
 * the operator surfaces. Table names carry a per-run suffix so a reused
 * local stack never collides; the collections specs never see this project's
 * tables and vice versa.
 */

const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/** A cookie-less context, mirroring how the collections spec makes anonymous calls. */
async function anonymousContext(baseURL: string | undefined): Promise<APIRequestContext> {
	const base = baseURL ?? process.env.BASE_URL ?? 'http://localhost:8797';
	return playwrightRequest.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
}

/** Sign up a fresh user on the db project and exchange for a project JWT. */
async function projectUserToken(baseURL: string | undefined, prefix: string): Promise<string> {
	const anon = await anonymousContext(baseURL);
	try {
		const signUp = await anon.post(authPath(DB_PROJECT, 'sign-up/email'), {
			data: { name: 'Table Spec User', email: uniqueEmail(prefix), password: 'db-spec-password-1' }
		});
		expect(signUp.ok(), await signUp.text()).toBeTruthy();
		const sessionToken = signUp.headers()['set-auth-token'];
		expect(sessionToken).toBeTruthy();

		const token = await anon.get(authPath(DB_PROJECT, 'token'), {
			headers: { authorization: `Bearer ${sessionToken}` }
		});
		expect(token.ok(), await token.text()).toBeTruthy();
		const { token: jwt } = await token.json();
		expect(jwt).toBeTruthy();
		return jwt;
	} finally {
		await anon.dispose();
	}
}

const TODO_COLUMNS = [
	{ name: 'title', type: 'text', nullable: false },
	{ name: 'done', type: 'boolean', default: false },
	{ name: 'priority', type: 'integer', min: 1, max: 5, default: 3 },
	{ name: 'meta', type: 'json' },
	{ name: 'email', type: 'text', unique: true }
];

test.describe('db agent (SQL tables)', () => {
	test('declares a table, enforces the schema, and round-trips typed rows', async ({
		request,
		baseURL
	}) => {
		const table = `todos-${run}`;
		const declare = await request.put(dbAdminTablePath(DB_PROJECT, table), {
			data: {
				readAccess: 'public',
				writeAccess: 'public',
				replication: 'off',
				columns: TODO_COLUMNS
			}
		});
		expect(declare.ok(), await declare.text()).toBeTruthy();
		const declared = await declare.json();
		expect(declared.name).toBe(table);
		expect(declared.columns.map((column: { name: string }) => column.name)).toEqual([
			'title',
			'done',
			'priority',
			'meta',
			'email'
		]);

		const anon = await anonymousContext(baseURL);
		try {
			// Tables are schema-first: an undeclared table 404s instead of
			// auto-creating the way collections do.
			const ghost = await anon.post(dbRowsPath(DB_PROJECT, `ghost-${run}`), {
				data: { data: { title: 'x' } }
			});
			expect(ghost.status()).toBe(404);

			// Insert: missing columns take their defaults; json stays null.
			const created = await anon.post(dbRowsPath(DB_PROJECT, table), {
				data: { data: { title: 'ship tables', email: `a-${run}@example.com` } }
			});
			expect(created.status(), await created.text()).toBe(201);
			const row = await created.json();
			expect(row.data).toEqual({
				title: 'ship tables',
				done: false,
				priority: 3,
				meta: null,
				email: `a-${run}@example.com`
			});
			expect(row.owner).toBeNull();

			// Schema enforcement: unknown column, wrong type, missing required,
			// out-of-bounds - each a 400 with an issues array.
			for (const [data, fragment] of [
				[{ title: 'x', ghost: 1 }, 'not a declared column'],
				[{ title: 7 }, 'must be a text'],
				[{ done: true }, 'is required'],
				[{ title: 'x', priority: 9 }, 'at most 5']
			] as const) {
				const refused = await anon.post(dbRowsPath(DB_PROJECT, table), { data: { data } });
				expect(refused.status(), JSON.stringify(data)).toBe(400);
				const body = await refused.json();
				expect(JSON.stringify(body.issues), JSON.stringify(data)).toContain(fragment);
			}

			// Unique column: the conflict names the column.
			const dupe = await anon.post(dbRowsPath(DB_PROJECT, table), {
				data: { data: { title: 'dupe', email: `a-${run}@example.com` } }
			});
			expect(dupe.status()).toBe(409);
			expect((await dupe.json()).error).toContain('email');

			// PATCH merges columns and validates the merged row.
			const patched = await anon.patch(dbRowPath(DB_PROJECT, table, row.id), {
				data: { meta: { tags: ['urgent'] }, priority: 5 }
			});
			expect(patched.ok(), await patched.text()).toBeTruthy();
			expect((await patched.json()).data.meta).toEqual({ tags: ['urgent'] });

			const overMerge = await anon.patch(dbRowPath(DB_PROJECT, table, row.id), {
				data: { priority: 9 }
			});
			expect(overMerge.status()).toBe(400);

			// Typed queries: integer comparison, desc order, json dotted path.
			const second = await anon.post(dbRowsPath(DB_PROJECT, table), {
				data: { data: { title: 'later', priority: 1, email: `b-${run}@example.com` } }
			});
			expect(second.status(), await second.text()).toBe(201);

			const byPriority = await anon.post(dbTableQueryPath(DB_PROJECT, table), {
				data: { orderBy: [{ field: 'priority', direction: 'desc' }], limit: 10 }
			});
			expect(byPriority.ok(), await byPriority.text()).toBeTruthy();
			const ordered = await byPriority.json();
			expect(ordered.docs.map((doc: { data: { priority: number } }) => doc.data.priority)).toEqual([
				5, 1
			]);

			const byTag = await anon.post(dbTableQueryPath(DB_PROJECT, table), {
				data: { where: [{ field: 'meta.tags', op: 'array-contains', value: 'urgent' }] }
			});
			expect(byTag.ok(), await byTag.text()).toBeTruthy();
			expect((await byTag.json()).docs).toHaveLength(1);

			// Unknown columns are compile-time refusals, never silent misses.
			const unknown = await anon.post(dbTableQueryPath(DB_PROJECT, table), {
				data: { where: [{ field: 'ghost', op: '==', value: 1 }] }
			});
			expect(unknown.status()).toBe(400);
			expect((await unknown.json()).error).toContain('not a declared column');

			// Delete round trip.
			const deleted = await anon.delete(dbRowPath(DB_PROJECT, table, row.id));
			expect(deleted.ok()).toBeTruthy();
			expect((await anon.get(dbRowPath(DB_PROJECT, table, row.id))).status()).toBe(404);
		} finally {
			await anon.dispose();
		}
	});

	test('alters additively and refuses destructive changes', async ({ request }) => {
		const table = `alter-${run}`;
		const base = [{ name: 'title', type: 'text' }];
		const declare = await request.put(dbAdminTablePath(DB_PROJECT, table), {
			data: { readAccess: 'public', writeAccess: 'public', replication: 'off', columns: base }
		});
		expect(declare.ok(), await declare.text()).toBeTruthy();

		// Additive: a new column with a default plus an index toggle.
		const grown = await request.put(dbAdminTablePath(DB_PROJECT, table), {
			data: {
				readAccess: 'public',
				writeAccess: 'public',
				replication: 'off',
				columns: [
					{ name: 'title', type: 'text', index: true },
					{ name: 'votes', type: 'integer', default: 0 }
				]
			}
		});
		expect(grown.ok(), await grown.text()).toBeTruthy();

		// Destructive: retype and remove are refused with the reason.
		for (const columns of [
			[
				{ name: 'title', type: 'json' },
				{ name: 'votes', type: 'integer', default: 0 }
			],
			[{ name: 'title', type: 'text', index: true }]
		]) {
			const refused = await request.put(dbAdminTablePath(DB_PROJECT, table), {
				data: { readAccess: 'public', writeAccess: 'public', replication: 'off', columns }
			});
			expect(refused.status(), JSON.stringify(columns)).toBe(400);
			expect((await refused.json()).error).toContain('cannot');
		}

		// Adding NOT NULL without a default to an existing table is refused.
		const notNull = await request.put(dbAdminTablePath(DB_PROJECT, table), {
			data: {
				readAccess: 'public',
				writeAccess: 'public',
				replication: 'off',
				columns: [
					{ name: 'title', type: 'text', index: true },
					{ name: 'votes', type: 'integer', default: 0 },
					{ name: 'state', type: 'text', nullable: false }
				]
			}
		});
		expect(notNull.status()).toBe(400);
		expect((await notNull.json()).error).toContain('without a default');
	});

	test('table and collection names share one namespace', async ({ request }) => {
		const name = `clash-${run}`;
		const collection = await request.put(dbAdminCollectionPath(DB_PROJECT, name), {
			data: { readAccess: 'public', writeAccess: 'public', replication: 'off' }
		});
		expect(collection.ok(), await collection.text()).toBeTruthy();

		const table = await request.put(dbAdminTablePath(DB_PROJECT, name), {
			data: {
				readAccess: 'public',
				writeAccess: 'public',
				replication: 'off',
				columns: [{ name: 'x', type: 'text' }]
			}
		});
		expect(table.status()).toBe(409);
		expect((await table.json()).error).toContain('already a collection');
	});

	test('owner mode scopes rows to the token subject', async ({ request, baseURL }) => {
		const table = `owned-${run}`;
		const declare = await request.put(dbAdminTablePath(DB_PROJECT, table), {
			data: {
				readAccess: 'owner',
				writeAccess: 'owner',
				replication: 'off',
				columns: [{ name: 'note', type: 'text', nullable: false }]
			}
		});
		expect(declare.ok(), await declare.text()).toBeTruthy();

		const anon = await anonymousContext(baseURL);
		try {
			// Tokenless traffic is refused outright.
			const refused = await anon.post(dbRowsPath(DB_PROJECT, table), {
				data: { data: { note: 'x' } }
			});
			expect(refused.status()).toBe(401);

			const aliceToken = await projectUserToken(baseURL, 'table-alice');
			const bobToken = await projectUserToken(baseURL, 'table-bob');
			const asAlice = { authorization: `Bearer ${aliceToken}` };
			const asBob = { authorization: `Bearer ${bobToken}` };

			const created = await anon.post(dbRowsPath(DB_PROJECT, table), {
				headers: asAlice,
				data: { data: { note: 'mine' } }
			});
			expect(created.status(), await created.text()).toBe(201);
			const row = await created.json();
			expect(row.owner).toBeTruthy();

			// Bob cannot see or touch Alice's row - 404, not 403: its existence
			// is itself private.
			expect(
				(await anon.get(dbRowPath(DB_PROJECT, table, row.id), { headers: asBob })).status()
			).toBe(404);
			expect(
				(
					await anon.delete(dbRowPath(DB_PROJECT, table, row.id), {
						headers: asBob
					})
				).status()
			).toBe(404);

			const bobQuery = await anon.post(dbTableQueryPath(DB_PROJECT, table), {
				headers: asBob,
				data: {}
			});
			expect(bobQuery.ok()).toBeTruthy();
			expect((await bobQuery.json()).docs).toHaveLength(0);

			const aliceQuery = await anon.post(dbTableQueryPath(DB_PROJECT, table), {
				headers: asAlice,
				data: {}
			});
			expect((await aliceQuery.json()).docs).toHaveLength(1);
		} finally {
			await anon.dispose();
		}
	});

	test('operator surfaces: unified query, ifAbsent conflicts, structural validation', async ({
		request
	}) => {
		const table = `ops-${run}`;
		const declare = await request.put(dbAdminTablePath(DB_PROJECT, table), {
			data: {
				readAccess: 'auth',
				writeAccess: 'auth',
				replication: 'off',
				columns: [
					{ name: 'label', type: 'text', nullable: false },
					{ name: 'stock', type: 'integer', min: 0, default: 0 }
				]
			}
		});
		expect(declare.ok(), await declare.text()).toBeTruthy();

		// Operator row write bypasses access modes AND policy bounds, but never
		// structure: the schema is the storage.
		const put = await request.put(dbAdminTableRowPath(DB_PROJECT, table, `ops-${run}-1`), {
			data: { data: { label: 'widget', stock: -5 } }
		});
		expect(put.ok(), await put.text()).toBeTruthy();
		expect((await put.json()).data.stock).toBe(-5);

		const badType = await request.put(dbAdminTableRowPath(DB_PROJECT, table, `ops-${run}-2`), {
			data: { data: { label: 42 } }
		});
		expect(badType.status()).toBe(400);

		// ifAbsent guards the dashboard ADD flow against overwrites.
		const conflict = await request.put(
			`${dbAdminTableRowPath(DB_PROJECT, table, `ops-${run}-1`)}?ifAbsent=1`,
			{ data: { data: { label: 'other' } } }
		);
		expect(conflict.status()).toBe(409);

		// One operator query surface for both engines: `table` selects the
		// typed engine, unknown names 404, naming both is a 400.
		const rows = await request.post(dbAdminQueryPath(DB_PROJECT), {
			data: { table, query: { where: [{ field: 'stock', op: '<', value: 0 }] } }
		});
		expect(rows.ok(), await rows.text()).toBeTruthy();
		expect((await rows.json()).docs).toHaveLength(1);

		const both = await request.post(dbAdminQueryPath(DB_PROJECT), {
			data: { table, collection: 'x', query: {} }
		});
		expect(both.status()).toBe(400);

		const missing = await request.post(dbAdminQueryPath(DB_PROJECT), {
			data: { table: `nope-${run}`, query: {} }
		});
		expect(missing.status()).toBe(404);

		const badQuery = await request.post(dbAdminQueryPath(DB_PROJECT), {
			data: { table, query: { where: [{ field: 'ghost', op: '==', value: 1 }] } }
		});
		expect(badQuery.status()).toBe(400);

		// Row delete, then the table itself.
		const deleted = await request.delete(dbAdminTableRowPath(DB_PROJECT, table, `ops-${run}-1`));
		expect(deleted.ok()).toBeTruthy();

		const dropped = await request.delete(dbAdminTablePath(DB_PROJECT, table));
		expect(dropped.ok(), await dropped.text()).toBeTruthy();
		const gone = await request.post(dbAdminQueryPath(DB_PROJECT), {
			data: { table, query: {} }
		});
		expect(gone.status()).toBe(404);
	});

	test('export streams NDJSON that import round-trips (tables)', async ({ request, baseURL }) => {
		const columns = [
			{ name: 'title', type: 'text', nullable: false },
			{ name: 'rank', type: 'integer', default: 0 },
			{ name: 'meta', type: 'json' }
		];
		const source = `exportsrc-${run}`;
		const provision = await request.put(dbAdminTablePath(DB_PROJECT, source), {
			data: { readAccess: 'public', writeAccess: 'public', replication: 'off', columns }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		const anon = await anonymousContext(baseURL);
		try {
			const ids = [0, 1, 2].map((index) => `exp-${run}-${index}`);
			for (const [index, id] of ids.entries()) {
				const created = await anon.post(dbRowsPath(DB_PROJECT, source), {
					data: { id, data: { title: `row ${index}`, rank: index, meta: { nested: index } } }
				});
				expect(created.status(), await created.text()).toBe(201);
			}

			const exported = await anon.get(dbTableExportPath(DB_PROJECT, source));
			expect(exported.ok(), await exported.text()).toBeTruthy();
			expect(exported.headers()['content-type']).toContain('application/x-ndjson');
			const lines = (await exported.text())
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { id: string; data: Record<string, unknown> });
			expect(lines.map((line) => line.id)).toEqual(ids);
			// Typed columns round-trip through the envelope: json parsed, ints ints.
			expect(lines[1].data).toMatchObject({ title: 'row 1', rank: 1, meta: { nested: 1 } });

			// The operator export streams the same rows through the parent.
			const adminExported = await request.get(`${dbAdminTablePath(DB_PROJECT, source)}/export`);
			expect(adminExported.ok(), await adminExported.text()).toBeTruthy();
			const adminLines = (await adminExported.text())
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { id: string });
			expect(adminLines.map((line) => line.id)).toEqual(ids);

			// Round trip into a fresh table: exported lines keep id, owner, and
			// timestamps; a bad JSON line and a wrong-typed line are reported
			// with their 1-based numbers without sinking the batch (structure
			// always validates - the schema is the storage).
			const target = `importtgt-${run}`;
			const provisionTarget = await request.put(dbAdminTablePath(DB_PROJECT, target), {
				data: { readAccess: 'public', writeAccess: 'public', replication: 'off', columns }
			});
			expect(provisionTarget.ok(), await provisionTarget.text()).toBeTruthy();

			const ownedCreatedAt = '2026-01-01T00:00:00.000Z';
			const ndjson = [
				...lines.map((line) => JSON.stringify(line)),
				JSON.stringify({
					id: `owned-${run}`,
					data: { title: 'owned', rank: 9 },
					owner: 'user-abc',
					createdAt: ownedCreatedAt,
					updatedAt: ownedCreatedAt
				}),
				'not json at all',
				JSON.stringify({ data: { title: 123 } }),
				JSON.stringify({ data: { title: 'minted' } })
			].join('\n');

			const imported = await request.post(`${dbAdminTablePath(DB_PROJECT, target)}/import`, {
				headers: { 'content-type': 'application/x-ndjson' },
				data: ndjson
			});
			expect(imported.ok(), await imported.text()).toBeTruthy();
			const report = (await imported.json()) as {
				imported: number;
				updated: number;
				errors: { line: number; error: string }[];
			};
			expect(report.imported).toBe(5);
			expect(report.updated).toBe(0);
			expect(report.errors).toHaveLength(2);
			expect(report.errors[0]).toEqual({ line: 5, error: 'not valid JSON' });
			expect(report.errors[1].line).toBe(6);
			expect(report.errors[1].error).toContain('must be a text');

			// Imported owner and timestamps survive; re-importing upserts.
			const rows = await request.post(dbAdminQueryPath(DB_PROJECT), {
				data: { table: target, query: {} }
			});
			expect(rows.ok(), await rows.text()).toBeTruthy();
			const docs = (await rows.json()).docs as {
				id: string;
				owner: string | null;
				createdAt: string;
			}[];
			expect(docs).toHaveLength(5);
			const owned = docs.find((doc) => doc.id === `owned-${run}`);
			expect(owned?.owner).toBe('user-abc');
			expect(owned?.createdAt).toBe(ownedCreatedAt);

			const again = await request.post(`${dbAdminTablePath(DB_PROJECT, target)}/import`, {
				headers: { 'content-type': 'application/x-ndjson' },
				data: lines.map((line) => JSON.stringify(line)).join('\n')
			});
			expect(again.ok(), await again.text()).toBeTruthy();
			expect((await again.json()).updated).toBe(3);
		} finally {
			await anon.dispose();
		}
	});

	test('table point-in-time restore validates input and reports unsupported locally', async ({
		request
	}) => {
		// Against a deployed stack a valid restore would REALLY roll back; the
		// local stack has no durable change log, which is the 501 this pins.
		test.skip(!!process.env.BASE_URL, 'restore against a deployed target would destroy data');

		const probe = 'rollback_probe_t';
		const provision = await request.put(dbAdminTablePath(DB_PROJECT, probe), {
			data: {
				readAccess: 'public',
				writeAccess: 'public',
				replication: 'off',
				columns: [{ name: 'note', type: 'text' }]
			}
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		const base = dbAdminTablePath(DB_PROJECT, probe);
		const both = await request.post(`${base}/restore`, {
			data: { timestamp: new Date().toISOString(), bookmark: 'x' }
		});
		expect(both.status()).toBe(400);

		const tooOld = await request.post(`${base}/restore`, {
			data: { timestamp: new Date(Date.now() - 35 * 24 * 3600 * 1000).toISOString() }
		});
		expect(tooOld.status()).toBe(400);

		const missing = await request.post(
			`${dbAdminTablePath(DB_PROJECT, 'nope_never_declared')}/restore`,
			{ data: { timestamp: new Date(Date.now() - 60_000).toISOString() } }
		);
		expect(missing.status()).toBe(404);

		const unsupported = await request.post(`${base}/restore`, {
			data: { timestamp: new Date(Date.now() - 60_000).toISOString() }
		});
		expect(unsupported.status(), await unsupported.text()).toBe(501);
		expect(((await unsupported.json()) as { error: string }).error).toContain(
			'point-in-time recovery'
		);

		// The dialog's up-front data, table-side: local stacks report
		// unsupported with no captured points, and checkpoint plus the D1-style
		// time-to-bookmark resolution degrade to the same clean 501.
		const points = await request.get(`${base}/restore-points`);
		expect(points.ok(), await points.text()).toBeTruthy();
		expect(await points.json()).toEqual({ supported: false, points: [] });

		const checkpoint = await request.post(`${base}/checkpoint`, { data: {} });
		expect(checkpoint.status(), await checkpoint.text()).toBe(501);

		const resolve = await request.get(
			`${base}/bookmark?at=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`
		);
		expect(resolve.status(), await resolve.text()).toBe(501);

		const badResolve = await request.get(`${base}/bookmark?at=not-a-time`);
		expect(badResolve.status()).toBe(400);
	});
});
