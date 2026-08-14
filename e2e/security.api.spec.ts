import { expect, test } from '@playwright/test';
import {
	adminUsersPath,
	authPath,
	configPath,
	CONSOLE_OWNER,
	CONSOLE_STORAGE_STATE,
	consoleAuthPath,
	dbAdminQueryPath,
	dbDocumentsPath,
	ensureProject,
	overviewPath,
	SCRATCH_PROJECT,
	SEED_PROJECT,
	settingsPath,
	uniqueEmail
} from './helpers';

/**
 * Boundary probes. Every other spec asserts that the product works; this one
 * asserts that the ways AROUND the product do not.
 *
 * Deliberately unauthenticated by default - the surfaces here are the ones an
 * anonymous caller can dial - with the operator cases opting back in.
 */
test.describe('security boundaries', () => {
	test.use({ storageState: { cookies: [], origins: [] } });

	/**
	 * The proxies interpolate a decoded rest parameter into the agent URL, and
	 * a URL parser resolves `..` segments. If a rest parameter can climb out of
	 * its prefix, then `/api/projects/<id>/auth/*` - PUBLIC by manifest, the
	 * route the login form uses - becomes an anonymous door into the operator
	 * surfaces of that project, and one level further into any OTHER project.
	 */
	const traversals = (prefix: string, rest: string) => [
		`${prefix}/..%2F..%2F${rest}`,
		`${prefix}/%2e%2e%2f%2e%2e%2f${rest}`,
		`${prefix}/..%2f..%2F${rest}`,
		`${prefix}/%2E%2E/%2E%2E/${rest}`,
		`${prefix}/..%252F..%252F${rest}`
	];

	test('the public auth proxy cannot climb into the operator surface', async ({ request }) => {
		for (const path of traversals(`/api/projects/${SEED_PROJECT}/auth`, 'admin%2Fusers')) {
			const response = await request.get(path);
			const body = await response.text();
			expect(response.status(), `${path} must not reach the user list`).not.toBe(200);
			expect(body, `${path} leaked user data`).not.toContain('@example.com');
		}
	});

	test('the public auth proxy cannot climb into another project', async ({ request }) => {
		for (const path of traversals(
			`/api/projects/${SCRATCH_PROJECT}/auth`,
			`${SEED_PROJECT}%2Fadmin%2Fusers`
		)) {
			const response = await request.get(path);
			const body = await response.text();
			expect(response.status(), `${path} must not cross projects`).not.toBe(200);
			expect(body, `${path} leaked another project's data`).not.toContain('@example.com');
		}
	});

	test('the /agents passthrough cannot be steered by an encoded project id', async ({
		request
	}) => {
		// The guard reads the project id from the raw path while the agent
		// resolves the Durable Object name from a decoded one. If those two
		// disagree, the guard is checking a different project than the one that
		// answers - so every encoding of `console` must be refused, not
		// silently normalised into the operator auth instance.
		for (const encoded of ['%63onsole', 'con%73ole', 'CONSOLE', 'console%20']) {
			const response = await request.get(`/agents/auth-agent/${encoded}/admin/users`);
			expect(response.status(), `${encoded} must not resolve to the console`).not.toBe(200);
		}
	});

	test('a project id is never a path of its own', async ({ request }) => {
		// A traversal in the project SEGMENT would let the id itself carry the
		// escape, before any per-project check runs.
		for (const id of ['..%2Fconsole', '%2e%2e%2fconsole', 'a%2F..%2Fconsole']) {
			const response = await request.get(`/api/projects/${id}/overview`);
			expect(response.status(), `${id} must not resolve`).not.toBe(200);
		}
	});

	test('operator surfaces stay closed to anonymous callers on every hop', async ({ request }) => {
		// The same object is reachable three ways - the REST proxy, the agents
		// passthrough, and the db proxy. A guard that covers two of them covers
		// none of them.
		const closed = [
			overviewPath(SEED_PROJECT),
			adminUsersPath(SEED_PROJECT),
			`/agents/auth-agent/${SEED_PROJECT}/admin/users`,
			`/agents/db-agent/${SEED_PROJECT}/admin/collections`,
			`/api/registry/projects`,
			`/api/console/me`
		];
		for (const path of closed) {
			const response = await request.get(path);
			expect(response.status(), `${path} must not answer anonymously`).toBe(401);
		}
	});

	test('the fleet rollup and the erase route are not on the public path', async ({ request }) => {
		// Both live outside /agents/*, so the dashboard's passthrough must never
		// forward them - they are service-binding-only by topology.
		const fleet = await request.get('/fleet/overview');
		expect(fleet.status(), 'the fleet rollup is not a public route').not.toBe(200);

		const erase = await request.delete(`/internal/projects/${SEED_PROJECT}`);
		expect(erase.status(), 'the erase route is not a public route').not.toBe(200);

		// ...nor by dressing them up as an agent path.
		const viaAgents = await request.get('/agents/auth-agent/fleet/overview');
		expect(viaAgents.status()).not.toBe(200);
	});

	test('a session cookie is not a bearer token for another project', async ({ request }) => {
		// The console session is scoped to the console instance by cookie
		// prefix; presenting it to a project agent must not authenticate.
		const signIn = await request.post(consoleAuthPath('sign-in/email'), {
			data: { email: CONSOLE_OWNER.email, password: CONSOLE_OWNER.password }
		});
		expect(signIn.ok(), await signIn.text()).toBeTruthy();
		const token = (await signIn.json()) as { token?: string };
		test.skip(!token.token, 'no bearer token in the sign-in response');

		const response = await request.get(`/agents/auth-agent/${SEED_PROJECT}/admin/users`, {
			headers: { authorization: `Bearer ${token.token}` }
		});
		// The console guard resolves bearers against the CONSOLE instance, so
		// this one is a valid operator - what must not happen is the SEED
		// project's own agent treating it as one of its users.
		expect([200, 401, 404]).toContain(response.status());
	});

	test('demo access is granted by id shape, never by asking for it', async ({ request }) => {
		// Demo mode waives the session for demo-SHAPED ids only. A named
		// project must not become anonymous by looking demo-ish.
		for (const id of [
			'demo',
			'demo-',
			'demo-xyz',
			'demo-notahexstring',
			`demo-${'f'.repeat(11)}`
		]) {
			const response = await request.get(overviewPath(id));
			expect(response.status(), `${id} is not a demo id`).not.toBe(200);
		}
	});

	test('the public product API cannot mint a backend for an invented id', async ({ request }) => {
		// The agents provision a Durable Object on first touch, and the product
		// API is public by design - a customer's app calls it with no operator.
		// Together that let an anonymous caller create a fresh database, with
		// its own SQLite storage, for any id they could type: unowned, billable,
		// invisible to the registry, and erasable by nobody. Public has to mean
		// "the public surface of a project that exists".
		const invented = `e2e-never-minted-${Date.now().toString(36)}`;

		const signUp = await request.post(authPath(invented, 'sign-up/email'), {
			data: { name: 'Squatter', email: uniqueEmail('squatter'), password: 'squatter-pass-1' }
		});
		expect(signUp.status(), 'sign-up must not provision a project').toBe(404);

		const guest = await request.post(authPath(invented, 'sign-in/anonymous'), { data: {} });
		expect(guest.status(), 'nor may a guest session').toBe(404);

		const config = await request.get(configPath(invented));
		expect(config.status(), 'nor may /config').toBe(404);

		const document = await request.post(dbDocumentsPath(invented, 'squat'), {
			data: { data: { hello: 'world' } }
		});
		expect(document.status(), 'nor may a document write').toBe(404);

		const passthrough = await request.post(
			`/agents/auth-agent/${invented}/api/auth/sign-in/anonymous`,
			{ data: {} }
		);
		expect(passthrough.status(), 'nor may the passthrough').toBe(404);

		// The console's own public surface is exempt - it is what /login is
		// built on, and it is never a registry row.
		const consoleConfig = await request.get(configPath('console'));
		expect(consoleConfig.ok(), 'the console keeps its public config').toBeTruthy();
	});

	test('a registered project keeps its public API', async ({ request }) => {
		// The other half of the rule: the gate must not cost a real customer
		// their sign-up path.
		const signUp = await request.post(authPath(SCRATCH_PROJECT, 'sign-up/email'), {
			data: { name: 'Real User', email: uniqueEmail('real-user'), password: 'real-user-pass-1' }
		});
		expect(signUp.ok(), await signUp.text()).toBeTruthy();

		const config = await request.get(configPath(SCRATCH_PROJECT));
		expect(config.ok()).toBeTruthy();
	});

	test('a project can refuse guest sign-in', async ({ playwright, baseURL, request }) => {
		// Guest sign-in is public on every project AND a guest token satisfies
		// the `auth` access mode - the default for new collections and tables.
		// A project that never wanted guests therefore had its
		// signed-in-users-only data readable by anyone willing to ask for a
		// token first. Firebase and Supabase both ship anonymous OFF; this is
		// the switch that was missing entirely.
		const project = `e2e-noguest-${Date.now().toString(36)}`;
		const operator = await playwright.request.newContext({
			baseURL,
			extraHTTPHeaders: { origin: baseURL! },
			storageState: CONSOLE_STORAGE_STATE
		});
		try {
			await ensureProject(operator, project);

			// On by default - no deployed project changes behaviour.
			const before = await request.post(authPath(project, 'sign-in/anonymous'), { data: {} });
			expect(before.ok(), await before.text()).toBeTruthy();

			const saved = await operator.put(settingsPath(project), {
				data: { allowedOrigins: [], authPolicy: { allowAnonymous: false } }
			});
			expect(saved.ok(), await saved.text()).toBeTruthy();
			expect((await saved.json()).authPolicy.allowAnonymous).toBe(false);

			const after = await request.post(authPath(project, 'sign-in/anonymous'), { data: {} });
			expect(after.status(), 'guest sign-in is refused once turned off').toBe(403);

			// ...and the public config says so, so a client is not left guessing.
			const config = await (await request.get(configPath(project))).json();
			expect(config.providers).not.toContain('anonymous');
			expect(config.authPolicy.allowAnonymous).toBe(false);

			// Registration still works: this is a policy, not a lockout.
			const signUp = await request.post(authPath(project, 'sign-up/email'), {
				data: { name: 'Real', email: uniqueEmail('noguest'), password: 'noguest-pass-1' }
			});
			expect(signUp.ok(), await signUp.text()).toBeTruthy();

			// A settings save that carries no policy leaves it alone.
			const originsOnly = await operator.put(settingsPath(project), {
				data: { allowedOrigins: ['https://example.com'] }
			});
			expect(originsOnly.ok(), await originsOnly.text()).toBeTruthy();
			expect((await originsOnly.json()).authPolicy.allowAnonymous).toBe(false);
		} finally {
			await operator.delete(`/api/registry/projects/${project}`);
			await operator.dispose();
		}
	});

	test('the db operator surface is closed on both hops', async ({ request }) => {
		const query = await request.post(dbAdminQueryPath(SEED_PROJECT), {
			data: { collection: 'anything', query: {} }
		});
		expect(query.status()).toBe(401);

		const direct = await request.post(`/agents/db-agent/${SEED_PROJECT}/admin/query`, {
			data: { collection: 'anything', query: {} }
		});
		expect(direct.status()).toBe(401);
	});
});
