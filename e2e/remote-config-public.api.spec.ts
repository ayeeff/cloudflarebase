import {
	expect,
	request as playwrightRequest,
	test,
	type APIRequestContext
} from '@playwright/test';
import { authPath, CONFIG_PROJECT, uniqueEmail } from './helpers';

/**
 * Remote Config's PUBLIC endpoint (RC2) - the evaluated one.
 *
 * The product property is that an app fetches its config with no account and no
 * setup. The security property is that what comes back is *values*, resolved
 * server-side, and never the rules that produced them: which cohorts exist,
 * what the rollout percentages are, and which flags are aimed at internal roles
 * all stay on the server. Every test below is one of those two, and the
 * negative ones matter more.
 */

const admin = `/api/projects/${CONFIG_PROJECT}/db/admin/remote-config`;
const publicPath = `/api/projects/${CONFIG_PROJECT}/db/remote-config`;
const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

async function anonymousContext(baseURL: string | undefined): Promise<APIRequestContext> {
	const base = baseURL ?? process.env.BASE_URL ?? 'http://localhost:8797';
	return playwrightRequest.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
}

async function projectUserToken(baseURL: string | undefined, prefix: string): Promise<string> {
	const anon = await anonymousContext(baseURL);
	try {
		const signUp = await anon.post(authPath(CONFIG_PROJECT, 'sign-up/email'), {
			data: { name: 'RC Public User', email: uniqueEmail(prefix), password: 'db-spec-password-1' }
		});
		expect(signUp.ok(), await signUp.text()).toBeTruthy();
		const token = await anon.get(authPath(CONFIG_PROJECT, 'token'), {
			headers: { authorization: `Bearer ${signUp.headers()['set-auth-token']}` }
		});
		expect(token.ok(), await token.text()).toBeTruthy();
		return (await token.json()).token as string;
	} finally {
		await anon.dispose();
	}
}

function key(name: string): string {
	return `${name}${run}`;
}

test.describe('remote config (public endpoint)', () => {
	test.use({ storageState: { cookies: [], origins: [] } });

	test('an anonymous app gets published values and never the drafts', async ({
		request,
		baseURL
	}) => {
		const live = key('live');
		const drafted = key('drafted');

		// One published parameter, one that never was.
		const operator = await playwrightRequest.newContext({
			baseURL: baseURL ?? process.env.BASE_URL ?? 'http://localhost:8797',
			storageState: 'e2e/.auth/console.json'
		});
		try {
			await operator.put(`${admin}/${live}`, {
				data: { valueType: 'boolean', defaultValue: true }
			});
			await operator.post(`${admin}/publish`, { data: { reason: 'rc2' } });
			await operator.put(`${admin}/${drafted}`, {
				data: { valueType: 'string', defaultValue: 'not yours yet' }
			});
		} finally {
			await operator.dispose();
		}

		// No account, no token, no setup - the whole point.
		const response = await request.get(publicPath);
		expect(response.ok(), await response.text()).toBeTruthy();
		const body = await response.json();
		expect(body.params[live]).toBe(true);
		// The draft must be absent entirely - not null, not false, absent.
		expect(Object.hasOwn(body.params, drafted)).toBe(false);
		expect(typeof body.fetchedAt).toBe('string');
	});

	test('the payload is values only - no rules, cohorts, or percentages', async ({
		request,
		baseURL
	}) => {
		const flag = key('secret');
		const operator = await playwrightRequest.newContext({
			baseURL: baseURL ?? process.env.BASE_URL ?? 'http://localhost:8797',
			storageState: 'e2e/.auth/console.json'
		});
		try {
			await operator.put(`${admin}/${flag}`, {
				data: {
					valueType: 'boolean',
					defaultValue: false,
					conditions: [
						{
							label: 'internal staff only',
							when: { role: ['admin'], rollout: { percent: 5, salt: 'project-vulcan' } },
							value: true
						}
					]
				}
			});
			await operator.post(`${admin}/publish`, { data: { reason: 'rc2' } });
		} finally {
			await operator.dispose();
		}

		const response = await request.get(publicPath);
		const raw = await response.text();
		expect(JSON.parse(raw).params[flag]).toBe(false);

		// The assertion that matters is a NEGATIVE: nothing about the targeting
		// may appear in what ships to an anonymous caller.
		for (const secret of [
			'project-vulcan',
			'internal staff only',
			'rollout',
			'percent',
			'conditions',
			'admin'
		]) {
			expect(raw.includes(secret), `payload leaked "${secret}"`).toBe(false);
		}
	});

	test('a client cannot claim a country', async ({ request, baseURL }) => {
		const currency = key('currency');
		const operator = await playwrightRequest.newContext({
			baseURL: baseURL ?? process.env.BASE_URL ?? 'http://localhost:8797',
			storageState: 'e2e/.auth/console.json'
		});
		try {
			await operator.put(`${admin}/${currency}`, {
				data: {
					valueType: 'string',
					defaultValue: 'usd',
					conditions: [{ when: { country: ['DE'] }, value: 'eur' }]
				}
			});
			await operator.post(`${admin}/publish`, { data: { reason: 'rc2' } });
		} finally {
			await operator.dispose();
		}

		// `cf-ipcountry` is what the console forwards from the edge, so it is
		// exactly the header an attacker would try. The proxy deletes the
		// caller's copy before setting its own.
		const spoofed = await request.get(publicPath, { headers: { 'cf-ipcountry': 'DE' } });
		expect((await spoofed.json()).params[currency]).toBe('usd');

		// And the rule itself works, proven through the test-only override the
		// local stack enables (a workerd colo resolves no country).
		const german = await request.get(publicPath, { headers: { 'x-cfb-country': 'DE' } });
		expect((await german.json()).params[currency]).toBe('eur');

		const american = await request.get(publicPath, { headers: { 'x-cfb-country': 'US' } });
		expect((await american.json()).params[currency]).toBe('usd');
	});

	test('role targeting needs a real token, and an invalid one is anonymous', async ({
		request,
		baseURL
	}) => {
		const staffOnly = key('staff');
		const operator = await playwrightRequest.newContext({
			baseURL: baseURL ?? process.env.BASE_URL ?? 'http://localhost:8797',
			storageState: 'e2e/.auth/console.json'
		});
		try {
			await operator.put(`${admin}/${staffOnly}`, {
				data: {
					valueType: 'boolean',
					defaultValue: false,
					conditions: [{ when: { role: ['admin'] }, value: true }]
				}
			});
			await operator.post(`${admin}/publish`, { data: { reason: 'rc2' } });
		} finally {
			await operator.dispose();
		}

		// A signed-in ordinary user is not staff.
		const token = await projectUserToken(baseURL, 'rc-public');
		const member = await request.get(publicPath, {
			headers: { authorization: `Bearer ${token}` }
		});
		expect((await member.json()).params[staffOnly]).toBe(false);

		// A garbage token must make the caller ANONYMOUS, never privileged, and
		// never an error - config has to resolve on a logged-out first run.
		const garbage = await request.get(publicPath, {
			headers: { authorization: 'Bearer not-a-token' }
		});
		expect(garbage.ok(), await garbage.text()).toBeTruthy();
		expect((await garbage.json()).params[staffOnly]).toBe(false);
	});

	test('a rollout is stable per uid and splits the population', async ({ request, baseURL }) => {
		const beta = key('beta');
		const operator = await playwrightRequest.newContext({
			baseURL: baseURL ?? process.env.BASE_URL ?? 'http://localhost:8797',
			storageState: 'e2e/.auth/console.json'
		});
		try {
			await operator.put(`${admin}/${beta}`, {
				data: {
					valueType: 'boolean',
					defaultValue: false,
					conditions: [{ when: { rollout: { percent: 50, salt: 'beta' } }, value: true }]
				}
			});
			await operator.post(`${admin}/publish`, { data: { reason: 'rc2' } });
		} finally {
			await operator.dispose();
		}

		const seen = new Map<string, boolean>();
		for (let index = 0; index < 12; index++) {
			const response = await request.get(`${publicPath}?uid=person-${index}`);
			seen.set(`person-${index}`, (await response.json()).params[beta] as boolean);
		}
		const included = [...seen.values()].filter(Boolean).length;
		expect(included, 'a 50% rollout should not be all-or-nothing').toBeGreaterThan(0);
		expect(included).toBeLessThan(12);

		// The same caller must get the same answer, or a flag flickers per fetch.
		const first = [...seen.entries()][0];
		const again = await request.get(`${publicPath}?uid=${first[0]}`);
		expect((await again.json()).params[beta]).toBe(first[1]);

		// No uid at all cannot match a rollout - fail closed rather than
		// bucketing everyone into whatever the empty string hashes to.
		const anonymous = await request.get(publicPath);
		expect((await anonymous.json()).params[beta]).toBe(false);
	});

	test('an etag lets an app skip the payload, and differs per cohort', async ({ request }) => {
		const first = await request.get(`${publicPath}?uid=etag-a`);
		const etag = first.headers()['etag'];
		expect(etag).toBeTruthy();

		const repeat = await request.get(`${publicPath}?uid=etag-a`, {
			headers: { 'if-none-match': etag }
		});
		expect(repeat.status()).toBe(304);

		// A caller in a different cohort must not share a validator, or a cache
		// that trusted it would serve one of them the other's config.
		const german = await request.get(publicPath, { headers: { 'x-cfb-country': 'DE' } });
		const american = await request.get(publicPath, { headers: { 'x-cfb-country': 'US' } });
		expect(german.headers()['etag']).not.toBe(american.headers()['etag']);
	});

	test('the endpoint is public but the admin surface behind it is not', async ({ request }) => {
		// Anonymous: values yes, management no. Both halves in one place, since
		// the pairing is the actual contract.
		expect((await request.get(publicPath)).ok()).toBeTruthy();
		expect((await request.get(admin)).status()).toBe(401);
		expect((await request.post(`${admin}/publish`, { data: {} })).status()).toBe(401);
	});

	test('a condition value must match the declared type', async ({ baseURL }) => {
		const typed = key('typedcond');
		const operator = await playwrightRequest.newContext({
			baseURL: baseURL ?? process.env.BASE_URL ?? 'http://localhost:8797',
			storageState: 'e2e/.auth/console.json'
		});
		try {
			// A boolean flag whose override is a string would resolve to "yes" for
			// one cohort and `true` for everyone else - a type that changes by
			// audience is worse than no type at all.
			const refused = await operator.put(`${admin}/${typed}`, {
				data: {
					valueType: 'boolean',
					defaultValue: false,
					conditions: [{ when: { country: ['DE'] }, value: 'yes' }]
				}
			});
			expect(refused.status()).toBe(400);
			expect((await refused.json()).error).toContain('condition 1');

			// A rule matching everybody is refused too: it is a changed default
			// wearing a costume, and far easier to create by accident.
			const empty = await operator.put(`${admin}/${typed}`, {
				data: {
					valueType: 'boolean',
					defaultValue: false,
					conditions: [{ when: {}, value: true }]
				}
			});
			expect(empty.status()).toBe(400);
		} finally {
			await operator.dispose();
		}
	});
});
