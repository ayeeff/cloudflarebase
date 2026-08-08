import { expect, test } from '@playwright/test';
import { adminSessionsPath, adminUsersPath, authPath, overviewPath, uniqueEmail } from './helpers';

/**
 * Users and sessions page KEYSET-style over `(createdAt, id)`. The invariant
 * worth pinning is not "a page came back" but that walking the whole list
 * yields every row exactly once - the failure offset paging would have.
 */
const run = Date.now().toString(36);
const PASSWORD = 'pagination-password-1';
const USER_COUNT = 5;

interface UserPageBody {
	users: { id: string; email: string; createdAt: string }[];
	nextCursor?: string;
}

interface SessionPageBody {
	sessions: { id: string; createdAt: string }[];
	nextCursor?: string;
}

/** Signs up `USER_COUNT` users on a private project and returns their emails. */
async function seedUsers(
	request: import('@playwright/test').APIRequestContext,
	project: string
): Promise<string[]> {
	const emails: string[] = [];
	for (let index = 0; index < USER_COUNT; index += 1) {
		const email = uniqueEmail(`paged-${index}`);
		const created = await request.post(authPath(project, 'sign-up/email'), {
			data: { email, password: PASSWORD, name: `Paged ${index}` }
		});
		expect(created.ok(), await created.text()).toBeTruthy();
		emails.push(email);
	}
	return emails;
}

test.describe('auth agent (pagination)', () => {
	test('walking the user list two at a time covers it exactly once', async ({ request }) => {
		const project = `e2e-auth-page-${run}`;
		const emails = await seedUsers(request, project);

		const seen: string[] = [];
		let cursor: string | undefined;
		let pages = 0;
		do {
			const query = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2';
			const response = await request.get(`${adminUsersPath(project)}${query}`);
			expect(response.ok(), await response.text()).toBeTruthy();
			const body = (await response.json()) as UserPageBody;
			expect(body.users.length).toBeGreaterThan(0);
			expect(body.users.length).toBeLessThanOrEqual(2);
			seen.push(...body.users.map((user) => user.email));
			cursor = body.nextCursor;
			pages += 1;
			// A cursor that never terminates is the bug this guards.
			expect(pages).toBeLessThan(10);
		} while (cursor);

		expect(new Set(seen).size, 'no row may repeat across pages').toBe(seen.length);
		for (const email of emails) expect(seen).toContain(email);
	});

	test('users come back newest first, and the last page drops the cursor', async ({ request }) => {
		const project = `e2e-auth-order-${run}`;
		const emails = await seedUsers(request, project);

		const response = await request.get(`${adminUsersPath(project)}?limit=${USER_COUNT}`);
		expect(response.ok(), await response.text()).toBeTruthy();
		const body = (await response.json()) as UserPageBody;

		expect(body.users).toHaveLength(USER_COUNT);
		// Newest first: the last account created leads.
		expect(body.users[0].email).toBe(emails.at(-1));
		const times = body.users.map((user) => new Date(user.createdAt).getTime());
		expect([...times].sort((a, b) => b - a)).toEqual(times);
		// Exactly the page size with nothing behind it must not advertise more.
		expect(body.nextCursor).toBeUndefined();
	});

	test('a mangled cursor restarts the list instead of failing', async ({ request }) => {
		const project = `e2e-auth-badcursor-${run}`;
		await seedUsers(request, project);

		const response = await request.get(`${adminUsersPath(project)}?cursor=not-a-real-cursor`);
		expect(response.ok(), await response.text()).toBeTruthy();
		const body = (await response.json()) as UserPageBody;
		expect(body.users).toHaveLength(USER_COUNT);
	});

	test('live sessions page the same way', async ({ request }) => {
		const project = `e2e-auth-sess-${run}`;
		await seedUsers(request, project);

		const seen: string[] = [];
		let cursor: string | undefined;
		let pages = 0;
		do {
			const query = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2';
			const response = await request.get(`${adminSessionsPath(project)}${query}`);
			expect(response.ok(), await response.text()).toBeTruthy();
			const body = (await response.json()) as SessionPageBody;
			seen.push(...body.sessions.map((session) => session.id));
			cursor = body.nextCursor;
			pages += 1;
			expect(pages).toBeLessThan(10);
		} while (cursor);

		// Every sign-up opened a session, and none may be served twice.
		expect(seen.length).toBeGreaterThanOrEqual(USER_COUNT);
		expect(new Set(seen).size).toBe(seen.length);
	});

	test('the overview carries the first page and no cursor below the page size', async ({
		request
	}) => {
		const project = `e2e-auth-ov-${run}`;
		await seedUsers(request, project);

		const overview = await (await request.get(overviewPath(project))).json();
		expect(overview.users).toHaveLength(USER_COUNT);
		// Under one page of rows there is nothing to continue to.
		expect(overview.usersNextCursor).toBeUndefined();
		expect(overview.sessionsNextCursor).toBeUndefined();
	});
});
