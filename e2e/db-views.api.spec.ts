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
	dbAdminViewPath,
	dbRowsPath,
	dbViewSqlPath,
	uniqueEmail
} from './helpers';

/**
 * Join views (JOIN1, docs/db-join-design.md): the one thing single-table SQL
 * cannot do. A view follows several tables' change logs into one Durable
 * Object's SQLite, so a SELECT can JOIN them.
 *
 * What this pins, in order of how badly it would hurt to get wrong:
 *
 * 1. a join actually returns joined rows, and new writes reach the view;
 * 2. the view is READ-ONLY - nothing that writes survives the gate;
 * 3. it cannot launder access: no token is a 401, and a member's permission
 *    key is required through the view exactly as it is directly;
 * 4. owner-scoped tables cannot be members, at declare time AND when a
 *    member turns owner-scoped afterwards;
 * 5. a member covered by a view cannot be deleted out from under it.
 *
 * Names carry a per-run suffix so a reused local stack never collides.
 */

const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

async function anonymousContext(baseURL: string | undefined): Promise<APIRequestContext> {
	const base = baseURL ?? process.env.BASE_URL ?? 'http://localhost:8797';
	return playwrightRequest.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
}

async function projectUserToken(baseURL: string | undefined, prefix: string): Promise<string> {
	const anon = await anonymousContext(baseURL);
	try {
		const signUp = await anon.post(authPath(DB_PROJECT, 'sign-up/email'), {
			data: { name: 'View Spec User', email: uniqueEmail(prefix), password: 'db-spec-password-1' }
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

const AUTHORS = [
	{ name: 'name', type: 'text', nullable: false },
	{ name: 'city', type: 'text' }
];
const BOOKS = [
	{ name: 'title', type: 'text', nullable: false },
	{ name: 'author_id', type: 'text', nullable: false, index: true },
	{ name: 'copies', type: 'integer', default: 1 }
];

test.describe('db agent (join views)', () => {
	/**
	 * Views are capped at 3 per project, far tighter than the 200-shard pool
	 * tables live in - so unlike the table specs, this one CANNOT leave its
	 * views behind. A reused local stack would hit the cap on the second run
	 * and every declaration would 429. Cleanup runs in afterAll rather than at
	 * the end of each test so a failing assertion still releases the slot.
	 */
	const created: string[] = [];

	test.afterAll(async ({ baseURL }) => {
		if (!created.length) return;
		const context = await playwrightRequest.newContext({
			baseURL: baseURL ?? process.env.BASE_URL ?? 'http://localhost:8797',
			storageState: 'e2e/.auth/console.json'
		});
		try {
			for (const view of created) await context.delete(dbAdminViewPath(DB_PROJECT, view));
		} finally {
			await context.dispose();
		}
	});

	test('joins two tables, and follows their writes', async ({ request, baseURL }) => {
		const authors = `authors-${run}`;
		const books = `books-${run}`;
		const view = `library-${run}`;

		for (const [table, columns] of [
			[authors, AUTHORS],
			[books, BOOKS]
		] as const) {
			const declare = await request.put(dbAdminTablePath(DB_PROJECT, table), {
				// Members must replicate: a view follows the change log.
				data: { readAccess: 'auth', writeAccess: 'auth', replication: 'auto', columns }
			});
			expect(declare.ok(), await declare.text()).toBeTruthy();
		}

		const token = await projectUserToken(baseURL, 'view-join');
		const anon = await anonymousContext(baseURL);
		try {
			const authorRow = await anon.post(dbRowsPath(DB_PROJECT, authors), {
				headers: { authorization: `Bearer ${token}` },
				data: { data: { name: 'Le Guin', city: 'Portland' } }
			});
			expect(authorRow.ok(), await authorRow.text()).toBeTruthy();
			const author = await authorRow.json();

			for (const title of ['A Wizard of Earthsea', 'The Dispossessed']) {
				const created = await anon.post(dbRowsPath(DB_PROJECT, books), {
					headers: { authorization: `Bearer ${token}` },
					data: { data: { title, author_id: author.id, copies: 2 } }
				});
				expect(created.ok(), await created.text()).toBeTruthy();
			}

			created.push(view);
			const declare = await request.put(dbAdminViewPath(DB_PROJECT, view), {
				data: { members: [authors, books] }
			});
			expect(declare.ok(), await declare.text()).toBeTruthy();
			expect((await declare.json()).members).toEqual([authors, books]);

			// THE point of the feature: a join across two Durable Objects'
			// worth of data, answered from one SQLite.
			const joined = await anon.post(dbViewSqlPath(DB_PROJECT, view), {
				headers: { authorization: `Bearer ${token}` },
				data: {
					sql:
						`SELECT a."name" AS author, b."title" AS title FROM ${JSON.stringify(books)} b ` +
						`JOIN ${JSON.stringify(authors)} a ON a."id" = b."author_id" ORDER BY b."title"`
				}
			});
			expect(joined.ok(), await joined.text()).toBeTruthy();
			const body = await joined.json();
			expect(body.success).toBe(true);
			expect(body.result.results).toEqual([
				{ author: 'Le Guin', title: 'A Wizard of Earthsea' },
				{ author: 'Le Guin', title: 'The Dispossessed' }
			]);

			// Aggregates over a join - the reporting read views exist for.
			const counted = await anon.post(dbViewSqlPath(DB_PROJECT, view), {
				headers: { authorization: `Bearer ${token}` },
				data: {
					sql:
						`SELECT a."name" AS author, COUNT(*) AS books, SUM(b."copies") AS copies ` +
						`FROM ${JSON.stringify(authors)} a JOIN ${JSON.stringify(books)} b ` +
						`ON b."author_id" = a."id" GROUP BY a."name"`
				}
			});
			expect(counted.ok(), await counted.text()).toBeTruthy();
			expect((await counted.json()).result.results).toEqual([
				{ author: 'Le Guin', books: 2, copies: 4 }
			]);

			// A write AFTER the view bootstrapped must reach it through the
			// feed. The freshness window is ~3s, so poll rather than sleep.
			const late = await anon.post(dbRowsPath(DB_PROJECT, books), {
				headers: { authorization: `Bearer ${token}` },
				data: { data: { title: 'The Left Hand of Darkness', author_id: author.id, copies: 1 } }
			});
			expect(late.ok(), await late.text()).toBeTruthy();

			await expect
				.poll(
					async () => {
						const followed = await anon.post(dbViewSqlPath(DB_PROJECT, view), {
							headers: { authorization: `Bearer ${token}` },
							data: { sql: `SELECT COUNT(*) AS n FROM ${JSON.stringify(books)}` }
						});
						if (!followed.ok()) return -1;
						return (await followed.json()).result.results[0].n as number;
					},
					{ timeout: 20_000, intervals: [500, 1000, 2000] }
				)
				.toBe(3);
		} finally {
			await anon.dispose();
		}
	});

	test('a view is read-only and cannot launder access', async ({ request, baseURL }) => {
		const people = `people-${run}`;
		const orders = `orders-${run}`;
		const view = `sales-${run}`;

		const declarePeople = await request.put(dbAdminTablePath(DB_PROJECT, people), {
			data: {
				readAccess: 'auth',
				writeAccess: 'auth',
				replication: 'auto',
				columns: [{ name: 'name', type: 'text', nullable: false }]
			}
		});
		expect(declarePeople.ok(), await declarePeople.text()).toBeTruthy();

		// This member demands a permission key the token will not carry.
		const declareOrders = await request.put(dbAdminTablePath(DB_PROJECT, orders), {
			data: {
				readAccess: 'auth',
				writeAccess: 'auth',
				replication: 'auto',
				readPermission: 'orders:read',
				columns: [{ name: 'total', type: 'integer', nullable: false }]
			}
		});
		expect(declareOrders.ok(), await declareOrders.text()).toBeTruthy();

		created.push(view);
		const declare = await request.put(dbAdminViewPath(DB_PROJECT, view), {
			data: { members: [people, orders] }
		});
		expect(declare.ok(), await declare.text()).toBeTruthy();

		const token = await projectUserToken(baseURL, 'view-gate');
		const anon = await anonymousContext(baseURL);
		try {
			// No token at all: a view is never anonymous, whatever its members are.
			const anonymous = await anon.post(dbViewSqlPath(DB_PROJECT, view), {
				data: { sql: `SELECT 1 AS n` }
			});
			expect(anonymous.status()).toBe(401);

			// A valid token that lacks a MEMBER's permission key: 403, not data.
			// Reading `orders` directly would 403 too - the view must not be a
			// way around that.
			const unentitled = await anon.post(dbViewSqlPath(DB_PROJECT, view), {
				headers: { authorization: `Bearer ${token}` },
				data: { sql: `SELECT COUNT(*) AS n FROM ${JSON.stringify(orders)}` }
			});
			expect(unentitled.status()).toBe(403);
			expect((await unentitled.json()).error).toContain(orders);

			// Read-only: every write verb is refused by the gate, before any
			// authorization runs, so the answer never depends on the caller.
			for (const sql of [
				`INSERT INTO ${JSON.stringify(people)} ("id") VALUES ('x')`,
				`UPDATE ${JSON.stringify(people)} SET "name" = 'x'`,
				`DELETE FROM ${JSON.stringify(people)}`,
				`DROP TABLE ${JSON.stringify(people)}`
			]) {
				const write = await anon.post(dbViewSqlPath(DB_PROJECT, view), {
					headers: { authorization: `Bearer ${token}` },
					data: { sql }
				});
				expect(write.status(), sql).toBe(400);
				expect((await write.json()).error, sql).toContain('read-only');
			}

			// Internal storage stays unreachable through the view, including the
			// view's own bookkeeping table.
			for (const table of ['changelog', 'view_sources', 'sqlite_master']) {
				const internal = await anon.post(dbViewSqlPath(DB_PROJECT, view), {
					headers: { authorization: `Bearer ${token}` },
					data: { sql: `SELECT * FROM ${table}` }
				});
				expect(internal.status(), table).toBe(400);
			}
		} finally {
			await anon.dispose();
		}
	});

	test('owner-scoped tables cannot be members, before or after the fact', async ({ request }) => {
		const owned = `owned-${run}`;
		const plain = `plain-${run}`;
		const view = `mixed-${run}`;

		const declareOwned = await request.put(dbAdminTablePath(DB_PROJECT, owned), {
			data: {
				readAccess: 'owner',
				writeAccess: 'owner',
				replication: 'auto',
				columns: [{ name: 'note', type: 'text' }]
			}
		});
		expect(declareOwned.ok(), await declareOwned.text()).toBeTruthy();

		const declarePlain = await request.put(dbAdminTablePath(DB_PROJECT, plain), {
			data: {
				readAccess: 'auth',
				writeAccess: 'auth',
				replication: 'auto',
				columns: [{ name: 'note', type: 'text' }]
			}
		});
		expect(declarePlain.ok(), await declarePlain.text()).toBeTruthy();

		// Row ownership does not survive a join, so the refusal is at declare
		// time and it says why.
		const refused = await request.put(dbAdminViewPath(DB_PROJECT, view), {
			data: { members: [owned, plain] }
		});
		expect(refused.status()).toBe(400);
		expect((await refused.json()).error).toContain('owner-scoped');

		// A member that turns owner-scoped AFTERWARDS is the same hole from the
		// other direction - the change is refused, not silently applied.
		const second = `second-${run}`;
		const declareSecond = await request.put(dbAdminTablePath(DB_PROJECT, second), {
			data: {
				readAccess: 'auth',
				writeAccess: 'auth',
				replication: 'auto',
				columns: [{ name: 'note', type: 'text' }]
			}
		});
		expect(declareSecond.ok(), await declareSecond.text()).toBeTruthy();

		const created = await request.put(dbAdminViewPath(DB_PROJECT, view), {
			data: { members: [plain, second] }
		});
		expect(created.ok(), await created.text()).toBeTruthy();

		const flip = await request.put(dbAdminTablePath(DB_PROJECT, second), {
			data: {
				readAccess: 'owner',
				writeAccess: 'owner',
				replication: 'auto',
				columns: [{ name: 'note', type: 'text' }]
			}
		});
		expect(flip.status()).toBe(409);
		expect((await flip.json()).error).toContain(view);

		// Switching replication off breaks the feed the view follows.
		const unreplicate = await request.put(dbAdminTablePath(DB_PROJECT, second), {
			data: {
				readAccess: 'auth',
				writeAccess: 'auth',
				replication: 'off',
				columns: [{ name: 'note', type: 'text' }]
			}
		});
		expect(unreplicate.status()).toBe(409);

		// And a member cannot be deleted out from under a view: a view missing
		// a member is invalid, not degraded.
		const deleteMember = await request.delete(dbAdminTablePath(DB_PROJECT, second));
		expect(deleteMember.status()).toBe(409);
		expect((await deleteMember.json()).error).toContain(view);

		// Delete the view, and the member frees up again.
		const dropView = await request.delete(dbAdminViewPath(DB_PROJECT, view));
		expect(dropView.ok(), await dropView.text()).toBeTruthy();
		const deleteAgain = await request.delete(dbAdminTablePath(DB_PROJECT, second));
		expect(deleteAgain.ok(), await deleteAgain.text()).toBeTruthy();
	});

	test('views are declared, never conjured, and report per-member follow state', async ({
		request
	}) => {
		const view = `ghost-${run}`;

		// An undeclared view is a 404 through the public path - reaching a URL
		// has never been how a shard comes into existence.
		const ghost = await request.post(dbViewSqlPath(DB_PROJECT, view), {
			data: { sql: 'SELECT 1' }
		});
		expect([401, 404]).toContain(ghost.status());

		const status = await request.get(dbAdminViewPath(DB_PROJECT, view));
		expect(status.status()).toBe(404);

		// Two members minimum: a one-table "join" is just a table.
		const tooFew = await request.put(dbAdminViewPath(DB_PROJECT, view), {
			data: { members: [`solo-${run}`] }
		});
		expect(tooFew.status()).toBe(400);

		// Members must exist as declared TABLES.
		const missing = await request.put(dbAdminViewPath(DB_PROJECT, view), {
			data: { members: [`nope-a-${run}`, `nope-b-${run}`] }
		});
		expect(missing.status()).toBe(400);
		expect((await missing.json()).error).toContain('not a declared table');
	});
});
