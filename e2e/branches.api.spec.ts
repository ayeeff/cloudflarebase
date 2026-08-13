import { expect, test } from '@playwright/test';
import {
	authPath,
	dbAdminCollectionPath,
	dbDocumentsPath,
	dbOverviewPath,
	overviewPath,
	SEED_PROJECT,
	uniqueEmail
} from './helpers';

/**
 * Project branches (docs/branches-design.md): a branch is a full registry row
 * whose id is `<root>--<branch>`, and the derived id IS the isolation - every
 * agent keys on project id, so a branch gets its own Durable Objects, users,
 * collections, and JWKS with zero agent involvement. These tests prove the
 * isolation with real agent traffic, pin every create-time refusal, and pin
 * the root-delete cascade.
 */

/** Unique per run so a locally reused stack never collides. Short enough that
 * `--stg` still fits the 48-char project-id ceiling. */
function rootId(): string {
	return `br-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`.slice(
		0,
		24
	);
}

async function createRoot(
	request: import('@playwright/test').APIRequestContext,
	id: string
): Promise<void> {
	const created = await request.post('/api/registry/projects', {
		data: { id, name: 'Branch Test' }
	});
	expect(created.status(), await created.text()).toBe(201);
}

function branchesPath(projectId: string): string {
	return `/api/projects/${projectId}/branches`;
}

test.describe('project branches', () => {
	test('a branch is a fully isolated project', async ({ request }) => {
		const root = rootId();
		await createRoot(request, root);

		const created = await request.post(branchesPath(root), { data: { branch: 'stg' } });
		expect(created.status(), await created.text()).toBe(201);
		const { branch } = await created.json();
		expect(branch.id).toBe(`${root}--stg`);
		expect(branch.parentId).toBe(root);
		expect(branch.branchName).toBe('stg');
		expect(branch.name).toBe('Branch Test (stg)');

		// The switcher's data source lists it under the root...
		const listed = await request.get(branchesPath(root));
		expect(listed.ok(), await listed.text()).toBeTruthy();
		const { branches } = await listed.json();
		expect(branches.map((b: { id: string }) => b.id)).toEqual([`${root}--stg`]);

		// ...and the registry lists it as a full row carrying its parentage.
		const registry = await (await request.get('/api/registry/projects')).json();
		const row = registry.projects.find((p: { id: string }) => p.id === `${root}--stg`);
		expect(row, 'a branch is a full registry row').toBeTruthy();
		expect(row.parentId).toBe(root);

		// Auth isolation: a sign-up on the BRANCH exists only on the branch.
		// Different agent instances, different databases - the root cannot see it.
		const email = uniqueEmail('branch-user');
		const signUp = await request.post(authPath(`${root}--stg`, 'sign-up/email'), {
			data: { name: 'Branch User', email, password: 'branch-user-password-1' }
		});
		expect(signUp.ok(), await signUp.text()).toBeTruthy();

		const branchOverview = await (await request.get(overviewPath(`${root}--stg`))).json();
		expect(branchOverview.users.length).toBe(1);
		expect(branchOverview.users[0].email).toBe(email);

		const rootOverview = await (await request.get(overviewPath(root))).json();
		expect(rootOverview.users.length, 'the root must not see branch users').toBe(0);

		// DB isolation: a collection provisioned and written on the branch is
		// invisible from the root project's db agent.
		const provision = await request.put(dbAdminCollectionPath(`${root}--stg`, 'notes'), {
			data: { readAccess: 'public', writeAccess: 'public', replication: 'off' }
		});
		expect(provision.ok(), await provision.text()).toBeTruthy();

		const doc = await request.post(dbDocumentsPath(`${root}--stg`, 'notes'), {
			data: { data: { title: 'branch only' } }
		});
		expect(doc.status(), await doc.text()).toBe(201);

		const branchDb = await (await request.get(dbOverviewPath(`${root}--stg`))).json();
		expect(branchDb.collections.map((c: { name: string }) => c.name)).toContain('notes');

		const rootDb = await (await request.get(dbOverviewPath(root))).json();
		expect(
			rootDb.collections.map((c: { name: string }) => c.name),
			'the root must not see branch collections'
		).not.toContain('notes');
	});

	test('branch creation refusals', async ({ request }) => {
		const root = rootId();
		await createRoot(request, root);
		const created = await request.post(branchesPath(root), { data: { branch: 'stg' } });
		expect(created.status()).toBe(201);

		// A duplicate branch answers 409, like a taken project id.
		const duplicate = await request.post(branchesPath(root), { data: { branch: 'stg' } });
		expect(duplicate.status()).toBe(409);

		// Branch-of-branch is refused: branch the root instead.
		const nested = await request.post(branchesPath(`${root}--stg`), { data: { branch: 'x2' } });
		expect(nested.status()).toBe(400);

		// `main` IS the root project - minting it would alias the bare id.
		const main = await request.post(branchesPath(root), { data: { branch: 'main' } });
		expect(main.status()).toBe(400);

		// Malformed names: uppercase, the separator itself, a leading hyphen,
		// empty, and one past the 16-char ceiling.
		for (const branch of ['Staging', 'st--g', '-stg', '', 'abcdefghijklmnopq']) {
			const response = await request.post(branchesPath(root), { data: { branch } });
			expect(response.status(), `branch name "${branch}" should be refused`).toBe(400);
		}

		// An unknown root is a 404, not a silent orphan row.
		const orphan = await request.post(branchesPath(rootId()), { data: { branch: 'stg' } });
		expect(orphan.status()).toBe(404);

		// Demo projects never get branches - a demo IS an ephemeral branch.
		const demo = await request.post(branchesPath('demo-0123456789abcdef0123'), {
			data: { branch: 'stg' }
		});
		expect(demo.status()).toBe(400);
	});

	test('a root is limited to 5 branches', async ({ request }) => {
		// The default MAX_BRANCHES_PER_ROOT ceiling - the e2e stack deliberately
		// does not override it (wrangler.e2e.jsonc raises only the per-org
		// project ceiling). The root is deleted afterwards so a reused stack
		// does not accumulate six rows per run.
		const root = rootId();
		await createRoot(request, root);
		try {
			for (let i = 1; i <= 5; i += 1) {
				const created = await request.post(branchesPath(root), { data: { branch: `b${i}` } });
				expect(created.status(), await created.text()).toBe(201);
			}
			const refused = await request.post(branchesPath(root), { data: { branch: 'b6' } });
			expect(refused.status()).toBe(409);
			expect((await refused.json()).error).toContain('5 branches');
		} finally {
			await request.delete(`/api/registry/projects/${root}`);
		}
	});

	test('the combined id must fit the 48-char project-id ceiling', async ({ request }) => {
		// 44-char root: `--stg` would make 49. The name passes the branch-name
		// schema, so the refusal can only come from the combined-length check.
		const longRoot = `brl${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
			.padEnd(44, 'x')
			.slice(0, 44);
		await createRoot(request, longRoot);

		// A root that leaves room takes the very same branch name - so the
		// refusal below can only be the combined-length check.
		const roomyRoot = `${longRoot.slice(0, 40)}ok`;
		await createRoot(request, roomyRoot);
		const accepted = await request.post(branchesPath(roomyRoot), { data: { branch: 'stg' } });
		expect(accepted.status()).toBe(201);

		const refused = await request.post(branchesPath(longRoot), { data: { branch: 'stg' } });
		expect(refused.status()).toBe(400);
		expect((await refused.json()).error).toContain('48');
	});

	test('new root ids may not contain the branch separator', async ({ request }) => {
		const response = await request.post('/api/registry/projects', {
			data: { id: `no${Date.now().toString(36)}--sep`, name: 'Nope' }
		});
		expect(response.status()).toBe(400);
	});

	test('deleting the root deletes its branches first, data included', async ({ request }) => {
		const root = rootId();
		await createRoot(request, root);
		const created = await request.post(branchesPath(root), { data: { branch: 'stg' } });
		expect(created.status(), await created.text()).toBe(201);

		// Give the BRANCH a real user, so the cascade has something to erase.
		const signUp = await request.post(authPath(`${root}--stg`, 'sign-up/email'), {
			data: { name: 'Doomed', email: uniqueEmail('doomed-branch'), password: 'doomed-branch-1' }
		});
		expect(signUp.ok(), await signUp.text()).toBeTruthy();
		const before = await (await request.get(overviewPath(`${root}--stg`))).json();
		expect(before.users.length).toBe(1);

		const deleted = await request.delete(`/api/registry/projects/${root}`);
		expect(deleted.ok(), await deleted.text()).toBeTruthy();

		// Both rows are gone - no branch row may outlive its root...
		const registry = await (await request.get('/api/registry/projects')).json();
		const ids = registry.projects.map((p: { id: string }) => p.id);
		expect(ids).not.toContain(root);
		expect(ids).not.toContain(`${root}--stg`);
		// The root is not merely branch-less, it is gone: an id with no registry
		// row is not a project, so its branch list is not a thing to read.
		expect((await request.get(branchesPath(root))).status()).toBe(404);

		// ...and the branch agent's database is empty rather than merely
		// unreferenced: the cascade ran a full per-branch erase fan-out.
		//
		// Deleted ids are unreachable (no row, no project), so the branch is
		// re-minted to look: whoever creates `stg` on this root next must get
		// an empty backend, never the deleted branch's users.
		await createRoot(request, root);
		const reborn = await request.post(branchesPath(root), { data: { branch: 'stg' } });
		expect(reborn.status(), await reborn.text()).toBe(201);

		await expect
			.poll(
				async () => {
					const after = await (await request.get(overviewPath(`${root}--stg`))).json();
					return after.users?.length ?? -1;
				},
				{ timeout: 15_000 }
			)
			.toBe(0);

		await request.delete(`/api/registry/projects/${root}`);
	});
});

test.describe('branches guard', () => {
	test.use({ storageState: { cookies: [], origins: [] } });

	test('branch routes require an operator session', async ({ request }) => {
		const list = await request.get(branchesPath(SEED_PROJECT));
		expect(list.status()).toBe(401);

		const create = await request.post(branchesPath(SEED_PROJECT), { data: { branch: 'stg' } });
		expect(create.status()).toBe(401);
	});
});
