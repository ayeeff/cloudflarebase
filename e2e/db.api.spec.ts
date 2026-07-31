import {
	expect,
	request as playwrightRequest,
	test,
	type APIRequestContext
} from '@playwright/test';
import {
	authPath,
	DB_PROJECT,
	dbAdminAggregatePath,
	dbAdminCollectionPath,
	dbAdminExportPath,
	dbAdminImportPath,
	dbAdminQueryPath,
	dbAdminRestorePath,
	dbAggregatePath,
	dbDocumentPath,
	dbDocumentsPath,
	dbExportPath,
	dbQueryPath,
	overviewPath,
	uniqueEmail
} from './helpers';

/**
 * The db agent's document API through the dashboard proxy, exactly as a
 * customer's app would call it. The operator (this project's storageState)
 * provisions collections; the data path itself is exercised from fresh,
 * cookie-less contexts so nothing here accidentally leans on the console
 * session. Every write carries a per-run marker or id so a reused local stack
 * stays consistent (documents from earlier runs are invisible to the queries
 * asserted on).
 */

/** Unique-per-run discriminator for ids and query markers. */
const run = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

/** A cookie-less context, mirroring how the demo spec makes anonymous calls. */
async function anonymousContext(baseURL: string | undefined): Promise<APIRequestContext> {
	const base = baseURL ?? process.env.BASE_URL ?? 'http://localhost:8797';
	return playwrightRequest.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
}

/**
 * Signs up a fresh user on the db project and exchanges the session token for
 * a project JWT - the exact flow the Integration tab documents for token-mode
 * collections. Uses its own context so user sessions never bleed into others.
 */
async function projectUserToken(baseURL: string | undefined, prefix: string): Promise<string> {
	const anon = await anonymousContext(baseURL);
	try {
		const signUp = await anon.post(authPath(DB_PROJECT, 'sign-up/email'), {
			data: { name: 'Db Spec User', email: uniqueEmail(prefix), password: 'db-spec-password-1' }
		});
		expect(signUp.ok(), await signUp.text()).toBeTruthy();
		const sessionToken = signUp.headers()['set-auth-token'];
		expect(sessionToken, 'set-auth-token must be exposed for external clients').toBeTruthy();

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

test.describe('db agent (documents API)', () => {
	test('a public collection serves anonymous CRUD and query round trips', async ({
		request,
		baseURL
	}) => {
		// Operator provisions the collection; the PUT is an idempotent upsert.
		const provision = await request.put(dbAdminCollectionPath(DB_PROJECT, 'public_notes'), {
			data: { readAccess: 'public', writeAccess: 'public' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();
		expect(await provision.json()).toEqual({
			name: 'public_notes',
			readAccess: 'public',
			writeAccess: 'public',
			readPermission: null,
			writePermission: null,
			validator: null
		});

		const anon = await anonymousContext(baseURL);
		try {
			const firstId = `note-${run}-1`;
			const secondId = `note-${run}-2`;

			const created = await anon.post(dbDocumentsPath(DB_PROJECT, 'public_notes'), {
				data: { id: firstId, data: { title: 'first', run } }
			});
			expect(created.status(), await created.text()).toBe(201);
			const createdDoc = await created.json();
			expect(createdDoc.id).toBe(firstId);
			expect(createdDoc.data).toEqual({ title: 'first', run });
			expect(createdDoc.owner).toBeNull();

			const second = await anon.post(dbDocumentsPath(DB_PROJECT, 'public_notes'), {
				data: { id: secondId, data: { title: 'second', run } }
			});
			expect(second.status()).toBe(201);

			const read = await anon.get(dbDocumentPath(DB_PROJECT, 'public_notes', firstId));
			expect(read.ok()).toBeTruthy();
			expect((await read.json()).data.title).toBe('first');

			// PUT replaces the whole data record.
			const replaced = await anon.put(dbDocumentPath(DB_PROJECT, 'public_notes', firstId), {
				data: { title: 'replaced', run }
			});
			expect(replaced.ok(), await replaced.text()).toBeTruthy();
			expect((await replaced.json()).data).toEqual({ title: 'replaced', run });

			// PATCH merges into it.
			const patched = await anon.patch(dbDocumentPath(DB_PROJECT, 'public_notes', firstId), {
				data: { starred: true }
			});
			expect(patched.ok(), await patched.text()).toBeTruthy();
			expect((await patched.json()).data).toEqual({ title: 'replaced', run, starred: true });

			const queried = await anon.post(dbQueryPath(DB_PROJECT, 'public_notes'), {
				data: {
					where: [{ field: 'run', op: '==', value: run }],
					orderBy: [{ field: 'title', direction: 'asc' }]
				}
			});
			expect(queried.ok(), await queried.text()).toBeTruthy();
			const { docs } = await queried.json();
			expect(docs.map((doc: { id: string }) => doc.id)).toEqual([firstId, secondId]);

			const deleted = await anon.delete(dbDocumentPath(DB_PROJECT, 'public_notes', secondId));
			expect(deleted.ok()).toBeTruthy();
			expect(await deleted.json()).toEqual({ deleted: true });

			const gone = await anon.get(dbDocumentPath(DB_PROJECT, 'public_notes', secondId));
			expect(gone.status()).toBe(404);
		} finally {
			await anon.dispose();
		}
	});

	test('a default-mode collection rejects tokenless writes and honors a project token', async ({
		baseURL
	}) => {
		const anon = await anonymousContext(baseURL);
		try {
			// Unknown collections auto-create with auth/auth modes on first use, so
			// the very first tokenless write is already a 401 - never an open door.
			const tokenless = await anon.post(dbDocumentsPath(DB_PROJECT, 'secure_notes'), {
				data: { data: { title: 'no token' } }
			});
			expect(tokenless.status(), await tokenless.text()).toBe(401);

			const jwt = await projectUserToken(baseURL, 'db-secure');
			const headers = { authorization: `Bearer ${jwt}` };
			const docId = `secure-${run}`;

			const created = await anon.post(dbDocumentsPath(DB_PROJECT, 'secure_notes'), {
				data: { id: docId, data: { title: 'with token', run } },
				headers
			});
			expect(created.status(), await created.text()).toBe(201);

			const read = await anon.get(dbDocumentPath(DB_PROJECT, 'secure_notes', docId), { headers });
			expect(read.ok(), await read.text()).toBeTruthy();
			expect((await read.json()).data.title).toBe('with token');

			const patched = await anon.patch(dbDocumentPath(DB_PROJECT, 'secure_notes', docId), {
				data: { title: 'edited with token' },
				headers
			});
			expect(patched.ok(), await patched.text()).toBeTruthy();

			const queried = await anon.post(dbQueryPath(DB_PROJECT, 'secure_notes'), {
				data: { where: [{ field: 'run', op: '==', value: run }] },
				headers
			});
			expect(queried.ok(), await queried.text()).toBeTruthy();
			expect((await queried.json()).docs.map((doc: { id: string }) => doc.id)).toEqual([docId]);

			// Reads are gated exactly like writes.
			const tokenlessRead = await anon.get(dbDocumentPath(DB_PROJECT, 'secure_notes', docId));
			expect(tokenlessRead.status()).toBe(401);
		} finally {
			await anon.dispose();
		}
	});

	test('owner-mode collections scope every read and write to the token subject', async ({
		request,
		baseURL
	}) => {
		const provision = await request.put(dbAdminCollectionPath(DB_PROJECT, 'owner_notes'), {
			data: { readAccess: 'owner', writeAccess: 'owner' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		const jwtA = await projectUserToken(baseURL, 'db-owner-a');
		const jwtB = await projectUserToken(baseURL, 'db-owner-b');
		const headersA = { authorization: `Bearer ${jwtA}` };
		const headersB = { authorization: `Bearer ${jwtB}` };
		const idA = `own-a-${run}`;
		const idB = `own-b-${run}`;

		const anon = await anonymousContext(baseURL);
		try {
			for (const [id, headers] of [
				[idA, headersA],
				[idB, headersB]
			] as const) {
				const created = await anon.post(dbDocumentsPath(DB_PROJECT, 'owner_notes'), {
					data: { id, data: { run } },
					headers
				});
				expect(created.status(), await created.text()).toBe(201);
				expect((await created.json()).owner).toBeTruthy();
			}

			// Each user's query sees only their own documents - owner scoping is
			// applied server-side on top of the client's where clauses.
			for (const [mine, theirs, headers] of [
				[idA, idB, headersA],
				[idB, idA, headersB]
			] as const) {
				const queried = await anon.post(dbQueryPath(DB_PROJECT, 'owner_notes'), {
					data: { where: [{ field: 'run', op: '==', value: run }] },
					headers
				});
				expect(queried.ok(), await queried.text()).toBeTruthy();
				const ids = (await queried.json()).docs.map((doc: { id: string }) => doc.id);
				expect(ids).toContain(mine);
				expect(ids).not.toContain(theirs);
			}

			// Someone else's document 404s, not 403s - its existence is private.
			const crossRead = await anon.get(dbDocumentPath(DB_PROJECT, 'owner_notes', idA), {
				headers: headersB
			});
			expect(crossRead.status()).toBe(404);

			const ownRead = await anon.get(dbDocumentPath(DB_PROJECT, 'owner_notes', idA), {
				headers: headersA
			});
			expect(ownRead.ok()).toBeTruthy();
		} finally {
			await anon.dispose();
		}
	});

	test('creating a document with a taken id is refused with 409', async ({ request, baseURL }) => {
		const provision = await request.put(dbAdminCollectionPath(DB_PROJECT, 'public_notes'), {
			data: { readAccess: 'public', writeAccess: 'public' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		const anon = await anonymousContext(baseURL);
		try {
			const docId = `dup-${run}`;
			const first = await anon.post(dbDocumentsPath(DB_PROJECT, 'public_notes'), {
				data: { id: docId, data: { run } }
			});
			expect(first.status(), await first.text()).toBe(201);

			const second = await anon.post(dbDocumentsPath(DB_PROJECT, 'public_notes'), {
				data: { id: docId, data: { run } }
			});
			expect(second.status()).toBe(409);
		} finally {
			await anon.dispose();
		}
	});

	test('invalid queries are rejected with 400', async ({ request }) => {
		const provision = await request.put(dbAdminCollectionPath(DB_PROJECT, 'public_notes'), {
			data: { readAccess: 'public', writeAccess: 'public' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		const badOp = await request.post(dbQueryPath(DB_PROJECT, 'public_notes'), {
			data: { where: [{ field: 'run', op: '~', value: 'x' }] }
		});
		expect(badOp.status()).toBe(400);
	});

	test('oversized document data is refused with 413', async ({ request }) => {
		const provision = await request.put(dbAdminCollectionPath(DB_PROJECT, 'public_notes'), {
			data: { readAccess: 'public', writeAccess: 'public' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		// 140k characters serializes past the 128 KiB ceiling.
		const oversized = await request.post(dbDocumentsPath(DB_PROJECT, 'public_notes'), {
			data: { data: { blob: 'x'.repeat(140_000) } }
		});
		expect(oversized.status()).toBe(413);
	});

	test('cursor pagination pages in order with no overlap', async ({ request, baseURL }) => {
		const provision = await request.put(dbAdminCollectionPath(DB_PROJECT, 'pages'), {
			data: { readAccess: 'public', writeAccess: 'public' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		const anon = await anonymousContext(baseURL);
		try {
			const ids = [1, 2, 3, 4, 5].map((rank) => `page-${run}-${rank}`);
			for (const [index, id] of ids.entries()) {
				const created = await anon.post(dbDocumentsPath(DB_PROJECT, 'pages'), {
					data: { id, data: { run, rank: index + 1 } }
				});
				expect(created.status(), await created.text()).toBe(201);
			}

			// The run marker keeps documents from earlier reused-stack runs out of
			// the window, so the page contents are exact.
			const query = {
				where: [{ field: 'run', op: '==', value: run }],
				orderBy: [{ field: 'rank', direction: 'asc' }],
				limit: 2
			};

			const pageOf = async (cursor?: string) => {
				const response = await anon.post(dbQueryPath(DB_PROJECT, 'pages'), {
					data: cursor ? { ...query, cursor } : query
				});
				expect(response.ok(), await response.text()).toBeTruthy();
				return (await response.json()) as {
					docs: { id: string }[];
					nextCursor?: string;
				};
			};

			const first = await pageOf();
			expect(first.docs.map((doc) => doc.id)).toEqual([ids[0], ids[1]]);
			expect(first.nextCursor).toBeTruthy();

			const second = await pageOf(first.nextCursor);
			expect(second.docs.map((doc) => doc.id)).toEqual([ids[2], ids[3]]);
			expect(second.nextCursor).toBeTruthy();

			const third = await pageOf(second.nextCursor);
			expect(third.docs.map((doc) => doc.id)).toEqual([ids[4]]);
			expect(third.nextCursor).toBeUndefined();
		} finally {
			await anon.dispose();
		}
	});

	test('the operator admin query reads documents regardless of access modes', async ({
		request
	}) => {
		// auth/auth modes: no anonymous caller could read this back, but the
		// operator surface goes through the parent agent and bypasses the gate.
		const provision = await request.put(dbAdminCollectionPath(DB_PROJECT, 'admin_probe'), {
			data: { readAccess: 'auth', writeAccess: 'auth' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		const docId = `probe-${run}`;
		const upsert = await request.put(
			`${dbAdminCollectionPath(DB_PROJECT, 'admin_probe')}/documents/${docId}`,
			{ data: { data: { run, via: 'operator' } } }
		);
		expect(upsert.ok(), await upsert.text()).toBeTruthy();

		// A plain PUT replaces (the editor's semantics); ?ifAbsent=1 refuses a
		// taken id, which is what makes the dashboard's ADD flow safe.
		const replaced = await request.put(
			`${dbAdminCollectionPath(DB_PROJECT, 'admin_probe')}/documents/${docId}`,
			{ data: { data: { run, via: 'replaced' } } }
		);
		expect(replaced.ok(), await replaced.text()).toBeTruthy();
		const guarded = await request.put(
			`${dbAdminCollectionPath(DB_PROJECT, 'admin_probe')}/documents/${docId}?ifAbsent=1`,
			{ data: { data: { run, via: 'should not land' } } }
		);
		expect(guarded.status(), await guarded.text()).toBe(409);

		const queried = await request.post(dbAdminQueryPath(DB_PROJECT), {
			data: {
				collection: 'admin_probe',
				query: { where: [{ field: 'run', op: '==', value: run }] }
			}
		});
		expect(queried.ok(), await queried.text()).toBeTruthy();
		const { docs } = await queried.json();
		expect(docs.map((doc: { id: string }) => doc.id)).toEqual([docId]);
	});

	test('permission-gated collections honor the JWT permissions claim', async ({
		request,
		baseURL
	}) => {
		// A role carrying the permission, defined in the auth agent's registry.
		const defineRole = await request.put(`/api/projects/${DB_PROJECT}/admin/roles`, {
			data: { roles: [{ name: 'analyst', permissions: ['reports:read'] }] }
		});
		expect(defineRole.ok(), await defineRole.text()).toBeTruthy();

		// Any valid token may write; reading additionally needs reports:read.
		const provision = await request.put(dbAdminCollectionPath(DB_PROJECT, 'perm_reports'), {
			data: { readAccess: 'auth', writeAccess: 'auth', readPermission: 'reports:read' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();
		expect(await provision.json()).toMatchObject({
			readPermission: 'reports:read',
			writePermission: null
		});

		const anon = await anonymousContext(baseURL);
		try {
			const email = uniqueEmail('db-perm');
			const signUp = await anon.post(authPath(DB_PROJECT, 'sign-up/email'), {
				data: { name: 'Permission User', email, password: 'db-perm-password-1' }
			});
			expect(signUp.ok(), await signUp.text()).toBeTruthy();
			const bearer = signUp.headers()['set-auth-token'];
			expect(bearer).toBeTruthy();
			const tokenOf = async () => {
				const response = await anon.get(authPath(DB_PROJECT, 'token'), {
					headers: { authorization: `Bearer ${bearer}` }
				});
				expect(response.ok(), await response.text()).toBeTruthy();
				return ((await response.json()) as { token: string }).token;
			};

			// Default role: writes pass (no writePermission), reads are 403 - a
			// valid token lacking the right, distinct from the tokenless 401.
			const plainJwt = await tokenOf();
			const created = await anon.post(dbDocumentsPath(DB_PROJECT, 'perm_reports'), {
				data: { id: `perm-${run}`, data: { run } },
				headers: { authorization: `Bearer ${plainJwt}` }
			});
			expect(created.status(), await created.text()).toBe(201);

			for (const path of [
				dbQueryPath(DB_PROJECT, 'perm_reports'),
				dbAggregatePath(DB_PROJECT, 'perm_reports')
			]) {
				const denied = await anon.post(path, {
					data:
						path === dbQueryPath(DB_PROJECT, 'perm_reports')
							? {}
							: { aggregates: { total: { op: 'count' } } },
					headers: { authorization: `Bearer ${plainJwt}` }
				});
				expect(denied.status(), await denied.text()).toBe(403);
			}
			const deniedExport = await anon.get(dbExportPath(DB_PROJECT, 'perm_reports'), {
				headers: { authorization: `Bearer ${plainJwt}` }
			});
			expect(deniedExport.status()).toBe(403);

			// Grant the role; a FRESH token carries the permission and reads work.
			const overview = (await (await request.get(overviewPath(DB_PROJECT))).json()) as {
				users: { id: string; email: string }[];
			};
			const user = overview.users.find((entry) => entry.email === email);
			expect(user, 'the sign-up must appear in the auth overview').toBeTruthy();
			const promote = await request.put(
				`/api/projects/${DB_PROJECT}/admin/users/${encodeURIComponent(user!.id)}/role`,
				{ data: { role: 'analyst' } }
			);
			expect(promote.ok(), await promote.text()).toBeTruthy();

			const analystJwt = await tokenOf();
			const allowed = await anon.post(dbQueryPath(DB_PROJECT, 'perm_reports'), {
				data: { where: [{ field: 'run', op: '==', value: run }] },
				headers: { authorization: `Bearer ${analystJwt}` }
			});
			expect(allowed.ok(), await allowed.text()).toBeTruthy();
			expect((await allowed.json()).docs.map((doc: { id: string }) => doc.id)).toEqual([
				`perm-${run}`
			]);
		} finally {
			await anon.dispose();
		}
	});

	test('validator rules bind public writes but not the operator surface', async ({
		request,
		baseURL
	}) => {
		const provision = await request.put(dbAdminCollectionPath(DB_PROJECT, 'validated_notes'), {
			data: {
				readAccess: 'public',
				writeAccess: 'public',
				validator: {
					fields: {
						run: { type: 'string' },
						title: { type: 'string', required: true, maxLength: 20 },
						votes: { type: 'number', min: 0 },
						status: { enum: ['open', 'closed'] }
					},
					additionalFields: 'reject'
				}
			}
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();
		expect(await provision.json()).toMatchObject({
			validator: { fields: { title: { type: 'string', required: true, maxLength: 20 } } }
		});

		const anon = await anonymousContext(baseURL);
		try {
			const rejected = async (data: Record<string, unknown>, expected: string) => {
				const response = await anon.post(dbDocumentsPath(DB_PROJECT, 'validated_notes'), {
					data: { data }
				});
				expect(response.status(), await response.text()).toBe(400);
				const body = (await response.json()) as { error: string; issues: string[] };
				expect(body.error).toBe('document failed validation');
				expect(body.issues).toContain(expected);
			};

			await rejected({ run }, '"title" is required');
			await rejected({ run, title: 42 }, '"title" must be a string, got number');
			await rejected(
				{ run, title: 'a title definitely past twenty characters' },
				'"title" is limited to 20 characters'
			);
			await rejected({ run, title: 'ok', votes: -1 }, '"votes" must be at least 0');
			await rejected(
				{ run, title: 'ok', status: 'pending' },
				'"status" must be one of: "open", "closed"'
			);
			await rejected({ run, title: 'ok', sneaky: true }, '"sneaky" is not a declared field');

			const docId = `valid-${run}`;
			const good = await anon.post(dbDocumentsPath(DB_PROJECT, 'validated_notes'), {
				data: { id: docId, data: { run, title: 'ok', votes: 2, status: 'open' } }
			});
			expect(good.status(), await good.text()).toBe(201);

			// PATCH validates the merged document, so a partial cannot corrupt it.
			const badPatch = await anon.patch(dbDocumentPath(DB_PROJECT, 'validated_notes', docId), {
				data: { votes: -5 }
			});
			expect(badPatch.status(), await badPatch.text()).toBe(400);
			const goodPatch = await anon.patch(dbDocumentPath(DB_PROJECT, 'validated_notes', docId), {
				data: { votes: 7 }
			});
			expect(goodPatch.ok(), await goodPatch.text()).toBeTruthy();

			// The operator editor bypasses rules, exactly like access modes.
			const operatorPut = await request.put(
				`${dbAdminCollectionPath(DB_PROJECT, 'validated_notes')}/documents/operator-${run}`,
				{ data: { data: { run, sneaky: 'operator data', votes: -99 } } }
			);
			expect(operatorPut.ok(), await operatorPut.text()).toBeTruthy();
		} finally {
			await anon.dispose();
		}
	});

	test('aggregates compute count/sum/avg server-side', async ({ request, baseURL }) => {
		const provision = await request.put(dbAdminCollectionPath(DB_PROJECT, 'agg_votes'), {
			data: { readAccess: 'public', writeAccess: 'public' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		const anon = await anonymousContext(baseURL);
		try {
			const payloads = [{ votes: 3 }, { votes: 5 }, { votes: 'many' }, {}];
			for (const [index, payload] of payloads.entries()) {
				const created = await anon.post(dbDocumentsPath(DB_PROJECT, 'agg_votes'), {
					data: { id: `agg-${run}-${index}`, data: { run, ...payload } }
				});
				expect(created.status(), await created.text()).toBe(201);
			}

			const aggregate = await anon.post(dbAggregatePath(DB_PROJECT, 'agg_votes'), {
				data: {
					where: [{ field: 'run', op: '==', value: run }],
					aggregates: {
						total: { op: 'count' },
						votes: { op: 'sum', field: 'votes' },
						mean: { op: 'avg', field: 'votes' }
					}
				}
			});
			expect(aggregate.ok(), await aggregate.text()).toBeTruthy();
			// Non-numeric votes ('many', missing) are skipped by sum/avg but
			// still counted - Firestore semantics, pinned against real SQLite.
			expect(await aggregate.json()).toEqual({
				results: { total: 4, votes: 8, mean: 4 }
			});

			const invalid = await anon.post(dbAggregatePath(DB_PROJECT, 'agg_votes'), {
				data: { aggregates: { votes: { op: 'sum' } } }
			});
			expect(invalid.status()).toBe(400);

			// The operator mirror computes the same numbers through the parent.
			const adminAggregate = await request.post(dbAdminAggregatePath(DB_PROJECT), {
				data: {
					collection: 'agg_votes',
					aggregate: {
						where: [{ field: 'run', op: '==', value: run }],
						aggregates: { total: { op: 'count' } }
					}
				}
			});
			expect(adminAggregate.ok(), await adminAggregate.text()).toBeTruthy();
			expect(await adminAggregate.json()).toEqual({ results: { total: 4 } });
		} finally {
			await anon.dispose();
		}
	});

	test('owner-mode aggregates and exports see only the caller', async ({ request, baseURL }) => {
		const provision = await request.put(dbAdminCollectionPath(DB_PROJECT, 'owner_stats'), {
			data: { readAccess: 'owner', writeAccess: 'owner' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		const jwtA = await projectUserToken(baseURL, 'db-agg-a');
		const jwtB = await projectUserToken(baseURL, 'db-agg-b');
		const anon = await anonymousContext(baseURL);
		try {
			for (const [index, jwt] of [jwtA, jwtA, jwtB].entries()) {
				const created = await anon.post(dbDocumentsPath(DB_PROJECT, 'owner_stats'), {
					data: { id: `stat-${run}-${index}`, data: { run } },
					headers: { authorization: `Bearer ${jwt}` }
				});
				expect(created.status(), await created.text()).toBe(201);
			}

			for (const [jwt, expected] of [
				[jwtA, 2],
				[jwtB, 1]
			] as const) {
				const counted = await anon.post(dbAggregatePath(DB_PROJECT, 'owner_stats'), {
					data: {
						where: [{ field: 'run', op: '==', value: run }],
						aggregates: { total: { op: 'count' } }
					},
					headers: { authorization: `Bearer ${jwt}` }
				});
				expect(counted.ok(), await counted.text()).toBeTruthy();
				expect(await counted.json()).toEqual({ results: { total: expected } });
			}

			// Export respects owner scoping the same way.
			const exported = await anon.get(dbExportPath(DB_PROJECT, 'owner_stats'), {
				headers: { authorization: `Bearer ${jwtB}` }
			});
			expect(exported.ok(), await exported.text()).toBeTruthy();
			const lines = (await exported.text())
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { id: string; data: { run?: string } });
			const mine = lines.filter((line) => line.data.run === run);
			expect(mine.map((line) => line.id)).toEqual([`stat-${run}-2`]);
		} finally {
			await anon.dispose();
		}
	});

	test('export streams NDJSON that import round-trips', async ({ request, baseURL }) => {
		const provision = await request.put(dbAdminCollectionPath(DB_PROJECT, 'export_source'), {
			data: { readAccess: 'public', writeAccess: 'public' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		const anon = await anonymousContext(baseURL);
		try {
			const ids = [0, 1, 2].map((index) => `exp-${run}-${index}`);
			for (const [index, id] of ids.entries()) {
				const created = await anon.post(dbDocumentsPath(DB_PROJECT, 'export_source'), {
					data: { id, data: { run, rank: index } }
				});
				expect(created.status(), await created.text()).toBe(201);
			}

			const exported = await anon.get(dbExportPath(DB_PROJECT, 'export_source'));
			expect(exported.ok(), await exported.text()).toBeTruthy();
			expect(exported.headers()['content-type']).toContain('application/x-ndjson');
			const lines = (await exported.text())
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { id: string; data: { run?: string } });
			const exportedRun = lines.filter((line) => line.data.run === run);
			expect(exportedRun.map((line) => line.id)).toEqual(ids);

			// The operator export streams the same documents through the parent.
			const adminExported = await request.get(dbAdminExportPath(DB_PROJECT, 'export_source'));
			expect(adminExported.ok(), await adminExported.text()).toBeTruthy();
			const adminLines = (await adminExported.text())
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { id: string; data: { run?: string } });
			expect(adminLines.filter((line) => line.data.run === run).map((line) => line.id)).toEqual(
				ids
			);

			// Round trip into a fresh collection: exported lines keep id and
			// owner, a bare line mints an id, and a garbage line is reported
			// with its 1-based number without sinking the batch.
			const target = `import_target_${run.replace(/[^a-z0-9]/g, '')}`;
			const provisionTarget = await request.put(dbAdminCollectionPath(DB_PROJECT, target), {
				data: { readAccess: 'public', writeAccess: 'public' }
			});
			expect(provisionTarget.ok(), await provisionTarget.text()).toBeTruthy();

			const ndjson = [
				...exportedRun.map((line) => JSON.stringify(line)),
				JSON.stringify({ id: `owned-${run}`, data: { run }, owner: 'user-abc' }),
				'not json at all',
				JSON.stringify({ data: { run, minted: true } })
			].join('\n');

			const imported = await request.post(dbAdminImportPath(DB_PROJECT, target), {
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
			expect(report.errors).toEqual([{ line: 5, error: 'not valid JSON' }]);

			// Imported owner survives; re-importing the same body upserts.
			const owned = await request.post(dbAdminQueryPath(DB_PROJECT), {
				data: {
					collection: target,
					query: { where: [{ field: 'run', op: '==', value: run }] }
				}
			});
			expect(owned.ok(), await owned.text()).toBeTruthy();
			const docs = (await owned.json()).docs as { id: string; owner: string | null }[];
			expect(docs).toHaveLength(5);
			expect(docs.find((doc) => doc.id === `owned-${run}`)?.owner).toBe('user-abc');

			const again = await request.post(dbAdminImportPath(DB_PROJECT, target), {
				headers: { 'content-type': 'application/x-ndjson' },
				data: exportedRun.map((line) => JSON.stringify(line)).join('\n')
			});
			expect(again.ok(), await again.text()).toBeTruthy();
			expect((await again.json()).updated).toBe(3);
		} finally {
			await anon.dispose();
		}
	});

	test('point-in-time restore validates input and reports unsupported locally', async ({
		request
	}) => {
		// Against a deployed stack a valid restore would REALLY roll back; the
		// local stack has no durable change log, which is the 501 this pins.
		test.skip(!!process.env.BASE_URL, 'restore against a deployed target would destroy data');

		const provision = await request.put(dbAdminCollectionPath(DB_PROJECT, 'rollback_probe'), {
			data: { readAccess: 'public', writeAccess: 'public' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		const both = await request.post(dbAdminRestorePath(DB_PROJECT, 'rollback_probe'), {
			data: { timestamp: new Date().toISOString(), bookmark: 'x' }
		});
		expect(both.status()).toBe(400);

		const tooOld = await request.post(dbAdminRestorePath(DB_PROJECT, 'rollback_probe'), {
			data: { timestamp: new Date(Date.now() - 35 * 24 * 3600 * 1000).toISOString() }
		});
		expect(tooOld.status()).toBe(400);

		const missing = await request.post(dbAdminRestorePath(DB_PROJECT, 'nope_never_created'), {
			data: { timestamp: new Date(Date.now() - 60_000).toISOString() }
		});
		expect(missing.status()).toBe(404);

		const unsupported = await request.post(dbAdminRestorePath(DB_PROJECT, 'rollback_probe'), {
			data: { timestamp: new Date(Date.now() - 60_000).toISOString() }
		});
		expect(unsupported.status(), await unsupported.text()).toBe(501);
		expect(((await unsupported.json()) as { error: string }).error).toContain(
			'point-in-time recovery'
		);

		// The dialog's up-front data: local stacks report unsupported with no
		// captured points, and both the checkpoint and the D1-style
		// time-to-bookmark resolution degrade to the same clean 501.
		const points = await request.get(
			`${dbAdminCollectionPath(DB_PROJECT, 'rollback_probe')}/restore-points`
		);
		expect(points.ok(), await points.text()).toBeTruthy();
		expect(await points.json()).toEqual({ supported: false, points: [] });

		const checkpoint = await request.post(
			`${dbAdminCollectionPath(DB_PROJECT, 'rollback_probe')}/checkpoint`,
			{ data: {} }
		);
		expect(checkpoint.status(), await checkpoint.text()).toBe(501);

		const resolve = await request.get(
			`${dbAdminCollectionPath(DB_PROJECT, 'rollback_probe')}/bookmark?at=${encodeURIComponent(
				new Date(Date.now() - 60_000).toISOString()
			)}`
		);
		expect(resolve.status(), await resolve.text()).toBe(501);

		const badResolve = await request.get(
			`${dbAdminCollectionPath(DB_PROJECT, 'rollback_probe')}/bookmark?at=not-a-time`
		);
		expect(badResolve.status()).toBe(400);
	});

	test('deleting a collection erases it', async ({ request, baseURL }) => {
		const provision = await request.put(dbAdminCollectionPath(DB_PROJECT, 'doomed'), {
			data: { readAccess: 'public', writeAccess: 'public' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		const anon = await anonymousContext(baseURL);
		try {
			const created = await anon.post(dbDocumentsPath(DB_PROJECT, 'doomed'), {
				data: { id: `doomed-${run}`, data: { run } }
			});
			expect(created.status(), await created.text()).toBe(201);
		} finally {
			await anon.dispose();
		}

		const deleted = await request.delete(dbAdminCollectionPath(DB_PROJECT, 'doomed'));
		expect(deleted.ok(), await deleted.text()).toBeTruthy();
		expect(await deleted.json()).toEqual({ deleted: true });

		const afterwards = await request.post(dbAdminQueryPath(DB_PROJECT), {
			data: { collection: 'doomed', query: {} }
		});
		expect(afterwards.status()).toBe(404);
	});
});
