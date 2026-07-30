import {
	expect,
	request as playwrightRequest,
	test,
	type APIRequestContext
} from '@playwright/test';
import {
	authPath,
	DB_PROJECT,
	dbAdminCollectionPath,
	dbAdminQueryPath,
	dbDocumentPath,
	dbDocumentsPath,
	dbQueryPath,
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
			writeAccess: 'public'
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
