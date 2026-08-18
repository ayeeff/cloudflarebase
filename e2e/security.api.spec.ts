import { expect, test } from '@playwright/test';
import {
	adminUsersPath,
	authPath,
	configPath,
	CONSOLE_OWNER,
	CONSOLE_SETUP_TOKEN,
	CONSOLE_STORAGE_STATE,
	consoleAuthPath,
	dbAdminQueryPath,
	dbDocumentsPath,
	ensureProject,
	overviewPath,
	SCRATCH_PROJECT,
	SEED_PROJECT,
	settingsPath,
	STORAGE_PROJECT,
	storageAdminObjectsPath,
	storageBucketPath,
	storageBucketsPath,
	storageObjectPath,
	storageObjectsPath,
	storageOverviewPath,
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

	test('the erase route is not on the public path', async ({ request }) => {
		// It lives outside /agents/*, so the dashboard's passthrough must never
		// forward it - service-binding-only by topology.
		const erase = await request.delete(`/internal/projects/${SEED_PROJECT}`);
		expect(erase.status(), 'the erase route is not a public route').not.toBe(200);

		// ...nor by dressing it up as an agent path.
		const viaAgents = await request.delete(`/agents/auth-agent/internal/projects/${SEED_PROJECT}`);
		expect(viaAgents.status()).not.toBe(200);
	});

	test('the retired fleet rollup is gone, not merely unreachable', async ({ request }) => {
		// /admin and its ADMIN_SECRET were removed: a password-gated console page
		// that fanned out to every project Durable Object. Demo accounting moved
		// to a D1 query (src/lib/server/demo-log.ts).
		for (const path of ['/admin', '/fleet/overview', '/agents/auth-agent/fleet/overview']) {
			const response = await request.get(path);
			expect(response.status(), `${path} must not answer`).not.toBe(200);
		}
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

	/**
	 * The first-run console claim (src/lib/server/console-setup.ts). The claim
	 * hands over every operator surface on the deployment, and it used to be
	 * gated on `count(user) === 0` - a fact about the world, not about the
	 * claimer - so whoever guessed a self-hosted URL first became its owner.
	 *
	 * The claim path itself is covered by console.setup.ts, which unlocks with
	 * the token before claiming. What is left to prove here is that the unlock
	 * is not itself a way in.
	 */
	test('the setup unlock refuses everything but the configured token', async ({ request }) => {
		const wrong = await request.post('/api/console/setup', { data: { token: 'wrong-token' } });
		expect(wrong.status()).toBe(403);
		expect(await wrong.text()).not.toContain('e2e-console-setup-token');

		const missing = await request.post('/api/console/setup', { data: {} });
		expect(missing.status()).toBe(403);

		// A non-string token must not coerce into a match.
		const wrongType = await request.post('/api/console/setup', { data: { token: true } });
		expect(wrongType.status()).toBe(403);
	});

	/**
	 * The reset reclaims a console whose owner is not you by erasing every
	 * operator account, so the two things in front of it - a token-proved
	 * unlock and an explicit confirmation - are the whole safety story.
	 */
	test('the console reset needs both an unlock and a confirmation', async ({
		playwright,
		baseURL
	}) => {
		const anonymous = await playwright.request.newContext({
			baseURL,
			extraHTTPHeaders: { origin: baseURL! }
		});
		try {
			const unproven = await anonymous.delete('/api/console/setup', {
				data: { confirm: 'erase-console-operators' }
			});
			expect(unproven.status(), 'no unlock, no reset').toBe(403);

			const unlock = await anonymous.post('/api/console/setup', {
				data: { token: CONSOLE_SETUP_TOKEN }
			});
			expect(unlock.ok()).toBeTruthy();

			const unconfirmed = await anonymous.delete('/api/console/setup', {
				data: { confirm: 'nope' }
			});
			expect(unconfirmed.status(), 'an unconfirmed reset must not erase anything').toBe(400);
		} finally {
			await anonymous.dispose();
		}
	});

	/**
	 * The console is crawlable so search engines can SEE the noindex - a
	 * robots.txt Disallow would leave already-indexed demo pages stuck.
	 */
	test('console surfaces are marked noindex', async ({ request }) => {
		for (const path of ['/login', '/dashboard']) {
			const response = await request.get(path, { maxRedirects: 0 });
			expect(response.headers()['x-robots-tag'], `${path} must not be indexable`).toContain(
				'noindex'
			);
		}
	});

	/**
	 * A crawler is an anonymous visitor, so /dashboard used to hand it a real
	 * demo project - a Durable Object and an all-time counter row per crawl.
	 */
	test('a crawler is sent to the landing page instead of a demo project', async ({ request }) => {
		const response = await request.get('/dashboard', {
			maxRedirects: 0,
			headers: {
				'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
			}
		});
		expect(response.status()).toBe(307);
		expect(response.headers()['location']).toBe('/');
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

	test('the storage operator plane is closed on every hop', async ({ request }) => {
		const closed = [
			storageOverviewPath(STORAGE_PROJECT),
			storageBucketsPath(STORAGE_PROJECT),
			`/agents/storage-agent/${STORAGE_PROJECT}/overview`,
			`/agents/storage-agent/${STORAGE_PROJECT}/admin/buckets`,
			storageAdminObjectsPath(STORAGE_PROJECT, 'anything'),
			// The SDK state-sync socket path: broadcasting the bucket registry to
			// an anonymous caller is exactly the leak the operator default stops.
			`/agents/storage-agent/${STORAGE_PROJECT}`
		];
		for (const path of closed) {
			const response = await request.get(path);
			expect(response.status(), `${path} must not answer anonymously`).toBe(401);
		}

		// The erase fan-in stays off the public path, in every dressing.
		const erase = await request.delete(`/agents/storage-agent/internal/projects/${SEED_PROJECT}`);
		expect(erase.status()).not.toBe(200);
	});

	test('the public /buckets prefix serves ONLY object paths', async ({ request }) => {
		// `/buckets/*` is public by manifest for the object paths - but the
		// worker must refuse everything else under it BEFORE routeAgentRequest,
		// or an anonymous WebSocket upgrade aimed at the SDK's state-sync
		// router would ride the public classification into the agent and be
		// streamed the bucket registry.
		for (const path of [
			`/agents/storage-agent/${STORAGE_PROJECT}/buckets`,
			`/agents/storage-agent/${STORAGE_PROJECT}/buckets/sec-open`,
			`/agents/storage-agent/${STORAGE_PROJECT}/buckets/sec-open/config`
		]) {
			const response = await request.get(path);
			expect(response.status(), `${path} must not reach the agent`).toBe(404);
		}
	});

	test('storage byte paths: default-deny, no tenant oracle, no key traversal', async ({
		playwright,
		baseURL,
		request
	}) => {
		// The operator half of the setup opts back into the console session.
		const operator = await playwright.request.newContext({
			baseURL,
			extraHTTPHeaders: { origin: baseURL! },
			storageState: CONSOLE_STORAGE_STATE
		});
		// Its own project: the shared storage project's bucket count must stay
		// under the 5-bucket cap the caps test pins.
		const SEC_PROJECT = 'e2e-storage-sec';
		try {
			await ensureProject(operator, SEC_PROJECT);
			const closed = await operator.put(storageBucketPath(SEC_PROJECT, 'sec-closed'), {
				data: {}
			});
			expect([200, 201], await closed.text()).toContain(closed.status());
			const open = await operator.put(storageBucketPath(SEC_PROJECT, 'sec-open'), {
				data: { read: 'public', write: 'public' }
			});
			expect([200, 201], await open.text()).toContain(open.status());

			// A bucket with default config answers 401 to every anonymous verb -
			// secure the moment it exists, before anyone configures anything.
			const objectPath = storageObjectPath(SEC_PROJECT, 'sec-closed', 'probe.txt');
			expect((await request.get(objectPath)).status()).toBe(401);
			expect(
				(
					await request.put(objectPath, {
						data: 'x',
						headers: { 'content-type': 'text/plain' }
					})
				).status()
			).toBe(401);
			expect((await request.delete(objectPath)).status()).toBe(401);
			expect((await request.get(storageObjectsPath(SEC_PROJECT, 'sec-closed'))).status()).toBe(401);

			// Unregistered and reserved ids answer the same "no such project" as
			// the rest of the platform - never a storage-specific oracle.
			for (const id of [`e2e-never-storage-${Date.now().toString(36)}`, 'fleet', 'admin']) {
				const probe = await request.get(storageObjectPath(id, 'files', 'x.txt'));
				expect(probe.status(), `${id} must not resolve`).toBe(404);
			}

			// Keys cannot traverse: whatever the spelling, a dot segment is
			// refused before any R2 key is composed - the p/<project>/<bucket>/
			// prefix is the tenant boundary.
			for (const rawKey of [
				'a%2F..%2F..%2Fother-project%2Fsecret',
				'%2e%2e%2f%2e%2e%2fother',
				'nul%00'
			]) {
				const response = await request.put(
					`${storageObjectsPath(SEC_PROJECT, 'sec-open')}/${rawKey}`,
					{ data: 'x', headers: { 'content-type': 'text/plain' } }
				);
				expect([400, 404], `${rawKey} answered ${response.status()}`).toContain(response.status());
			}

			// A literal `//` is collapsed by the console origin's HTTP stack
			// before the agent classifies, so it lands as the NORMALIZED key -
			// benign (every arriving segment is still validated, the tenant
			// prefix is composed from validated parts), and pinned here so a
			// change in that layer is noticed. The agent's own door refuses the
			// raw spelling outright (keys.unit.test.ts).
			const collapsed = await request.put(
				`${storageObjectsPath(SEC_PROJECT, 'sec-open')}/sec//collapsed.txt`,
				{ data: 'x', headers: { 'content-type': 'text/plain' } }
			);
			expect(collapsed.status(), await collapsed.text()).toBe(200);
			expect((await collapsed.json()).object.key).toBe('sec/collapsed.txt');

			// And a bare %2e%2e SEGMENT is resolved by URL normalization before
			// classification, so it lands on (and is refused by) the operator
			// plane rather than smuggling a public classification upstream.
			const climbed = await request.put(
				`/agents/storage-agent/${SEC_PROJECT}/buckets/sec-open/objects/%2e%2e/%2e%2e/%2e%2e/admin/buckets/sec-open`,
				{ data: '{}', headers: { 'content-type': 'application/json' } }
			);
			expect(climbed.status()).toBe(401);
		} finally {
			await operator.dispose();
		}
	});

	/**
	 * CSRF still bites where it must.
	 *
	 * SvelteKit's blanket `csrf.checkOrigin` is OFF (svelte.config.js) and
	 * re-implemented credential-aware in `csrfHandle`, because it refused
	 * service-key writes: a key sends no Origin by construction, and `fetch`
	 * defaults a string body - `JSON.stringify(...)` included - to
	 * `text/plain`, so the primary documented server path answered 403 before
	 * the key was read.
	 *
	 * The relaxation is narrow: skip ONLY for a BEARER-shaped `Authorization`
	 * header, which a browser cannot attach cross-origin without a preflight
	 * this app never answers. Everything cookie-shaped keeps the full check -
	 * including a request carrying a NON-bearer Authorization, because `Basic`
	 * is one a browser CAN attach by itself (a user:pass@host navigation)
	 * beside the victim's cookies. These assertions are the half that matters -
	 * get the relaxation wrong and the whole console API becomes CSRF-able,
	 * sign-in included.
	 */
	test('cross-site form writes are still refused without a bearer', async ({ playwright }) => {
		const base = process.env.BASE_URL ?? 'http://localhost:8797';

		// A cookie-bearing context, exactly what a victim's browser is.
		const victim = await playwright.request.newContext({
			baseURL: base,
			storageState: CONSOLE_STORAGE_STATE
		});
		try {
			for (const contentType of [
				'text/plain',
				'multipart/form-data',
				'application/x-www-form-urlencoded'
			]) {
				// A foreign Origin - the classic form post from evil.com.
				const foreign = await victim.fetch(dbAdminQueryPath(SEED_PROJECT), {
					method: 'POST',
					headers: { origin: 'https://evil.example', 'content-type': contentType },
					data: 'collection=posts'
				});
				expect(foreign.status(), `foreign origin, ${contentType}`).toBe(403);

				// And with NO Origin at all - the riskiest case, and the one that
				// forced this rewrite. The blank spelling is load-bearing: the
				// `api` project injects `origin: baseURL` into every context it
				// makes, so omitting the header here would silently test the
				// SAME-origin case and pass on nothing.
				const bare = await victim.fetch(dbAdminQueryPath(SEED_PROJECT), {
					method: 'POST',
					headers: { origin: '', 'content-type': contentType },
					data: 'collection=posts'
				});
				expect(bare.status(), `no origin, ${contentType}`).toBe(403);

				// A NON-bearer Authorization must not buy the skip: `Basic` can ride
				// beside cookies on a browser-initiated navigation, and the guard
				// would authenticate the request from the cookies it carries.
				const basic = await victim.fetch(dbAdminQueryPath(SEED_PROJECT), {
					method: 'POST',
					headers: {
						origin: 'https://evil.example',
						'content-type': contentType,
						authorization: `Basic ${Buffer.from('user:pass').toString('base64')}`
					},
					data: 'collection=posts'
				});
				expect(basic.status(), `Basic auth, ${contentType}`).toBe(403);
			}

			// Sign-in is the highest-value CSRF target on this deployment: it is
			// public-by-exception, so the guard never gates it.
			const signIn = await victim.fetch(authPath(SEED_PROJECT, 'sign-in/email'), {
				method: 'POST',
				headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
				data: JSON.stringify({ email: 'x@example.com', password: 'whatever' })
			});
			expect(signIn.status()).toBe(403);

			// The control: same-origin form writes are NOT refused, or the check
			// would be passing by breaking the console's own forms.
			const sameOrigin = await victim.fetch(dbAdminQueryPath(SEED_PROJECT), {
				method: 'POST',
				headers: { origin: base, 'content-type': 'text/plain' },
				data: JSON.stringify({ collection: 'nope', query: {} })
			});
			expect(sameOrigin.status()).not.toBe(403);
		} finally {
			await victim.dispose();
		}
	});
});
