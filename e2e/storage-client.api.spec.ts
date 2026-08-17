import { expect, test } from '@playwright/test';
import { createStorageClient, StorageError } from '../agents/storage/src/client';
import { authPath, ensureProject, storageBucketPath, uniqueEmail } from './helpers';

/**
 * The END-USER storage client (`@cloudflarebase/storage/client`).
 *
 * Drives the REAL exported client rather than a hand-rolled fetch at the same
 * URLs - the point is to prove the published surface works, including its URL
 * building, its bearer header, its Content-Length handling, and its error
 * mapping. The admin-sdk spec's rule.
 *
 * This is the browser-shaped credential: a project JWT, subject to the
 * bucket's access modes. Its server-side counterpart (`/admin`, service key,
 * modes bypassed) is covered in admin-sdk.api.spec.ts.
 */

const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const CLIENT_PROJECT = 'e2e-storage-client';
const BUCKET = 'spec-client';

function base(baseURL: string | undefined): string {
	return baseURL ?? process.env.BASE_URL ?? 'http://localhost:8797';
}

test.describe('storage client SDK', () => {
	let token = '';
	let origin = '';

	test.beforeAll(async ({ playwright, request, baseURL }) => {
		origin = base(baseURL);
		await ensureProject(request, CLIENT_PROJECT);
		// `auth` modes: the client must carry the project JWT to do anything,
		// which is the shape a real browser app runs in.
		const bucket = await request.put(storageBucketPath(CLIENT_PROJECT, BUCKET), {
			data: { read: 'auth', write: 'auth', publicListing: false }
		});
		expect([200, 201], await bucket.text()).toContain(bucket.status());

		const anon = await playwright.request.newContext({
			baseURL: origin,
			extraHTTPHeaders: { origin }
		});
		try {
			const signUp = await anon.post(authPath(CLIENT_PROJECT, 'sign-up/email'), {
				data: {
					name: 'Storage Client User',
					email: uniqueEmail('storage-client'),
					password: 'storage-client-password-1'
				}
			});
			expect(signUp.ok(), await signUp.text()).toBeTruthy();
			const sessionToken = signUp.headers()['set-auth-token'];
			const minted = await anon.get(authPath(CLIENT_PROJECT, 'token'), {
				headers: { authorization: `Bearer ${sessionToken}` }
			});
			expect(minted.ok(), await minted.text()).toBeTruthy();
			token = (await minted.json()).token;
			expect(token).toBeTruthy();
		} finally {
			await anon.dispose();
		}
	});

	function client() {
		return createStorageClient({
			baseUrl: `${origin}/agents/storage-agent/${CLIENT_PROJECT}`,
			getToken: () => token
		});
	}

	test('upload, download, info, remove: the round trip', async () => {
		const files = client().from(BUCKET);
		const key = `${run}/notes.txt`;
		const body = 'client bytes';

		const uploaded = await files.upload(key, body, { contentType: 'text/plain' });
		expect(uploaded.key).toBe(key);
		expect(uploaded.size).toBe(body.length);
		expect(uploaded.contentType).toBe('text/plain');

		const downloaded = await files.download(key);
		expect(await downloaded.text()).toBe(body);

		const info = await files.info(key);
		expect(info.size).toBe(body.length);
		expect(info.contentType).toBe('text/plain');

		const removed = await files.remove([key]);
		expect(removed).toEqual([{ key, error: null }]);
		await expect(files.download(key)).rejects.toThrow(StorageError);
	});

	test('a Blob body carries its own content type and length', async () => {
		const files = client().from(BUCKET);
		const key = `${run}/blob.txt`;
		// The browser's actual shape: no explicit contentType, no explicit
		// length. Both have to be derived, or the agent answers 411.
		await files.upload(key, new Blob(['blob bytes'], { type: 'text/plain' }));
		const info = await files.info(key);
		expect(info.contentType).toBe('text/plain');
		expect(info.size).toBe(10);
		await files.remove([key]);
	});

	test('list is flat by default and folds into folders on request', async () => {
		const files = client().from(BUCKET);
		const keys = [`${run}/tree/a.txt`, `${run}/tree/sub/b.txt`, `${run}/tree/sub/c.txt`];
		for (const key of keys) await files.upload(key, 'x', { contentType: 'text/plain' });

		const flat = await files.list({ prefix: `${run}/tree/` });
		expect(flat.objects.map((o) => o.key).sort()).toEqual([...keys].sort());
		expect(flat.folders).toBeUndefined();

		const folded = await files.list({ prefix: `${run}/tree/`, folders: true });
		expect(folded.objects.map((o) => o.key)).toEqual([`${run}/tree/a.txt`]);
		expect(folded.folders).toEqual([{ prefix: `${run}/tree/sub/`, objectCount: 2 }]);

		await files.remove(keys);
	});

	test('createSignedUrl hands back a URL that needs no credential', async ({ playwright }) => {
		const files = client().from(BUCKET);
		const key = `${run}/signed.txt`;
		await files.upload(key, 'signed via sdk', { contentType: 'text/plain' });

		const signed = await files.createSignedUrl(key, { expiresIn: 300 });
		expect(signed.signedUrl).toContain('sig=');
		expect(signed.method).toBe('GET');

		// A context holding nothing at all - no cookie, no bearer.
		const nobody = await playwright.request.newContext();
		try {
			const response = await nobody.get(signed.signedUrl);
			expect(response.status(), await response.text()).toBe(200);
			expect(await response.text()).toBe('signed via sdk');
		} finally {
			await nobody.dispose();
		}
		await files.remove([key]);
	});

	test('createSignedUrls reports per-key failures without failing the call', async () => {
		const files = client().from(BUCKET);
		const key = `${run}/batch.txt`;
		await files.upload(key, 'batch', { contentType: 'text/plain' });

		const results = await files.createSignedUrls([key, 'bad/../key.txt'], { expiresIn: 120 });
		expect(results).toHaveLength(2);
		expect(results[0].signedUrl).toContain('sig=');
		expect(results[1].signedUrl).toBeNull();
		expect(results[1].error).toBeTruthy();

		await files.remove([key]);
	});

	test('the console proxy base is accepted and rewritten', async () => {
		// The natural guess. Public object paths do not exist there, so without
		// the rewrite this 404s in a way that looks like a broken install.
		const viaProxyBase = createStorageClient({
			baseUrl: `${origin}/api/projects/${CLIENT_PROJECT}/storage`,
			getToken: () => token
		}).from(BUCKET);
		const key = `${run}/rewritten.txt`;
		await viaProxyBase.upload(key, 'rewritten', { contentType: 'text/plain' });
		expect(await (await viaProxyBase.download(key)).text()).toBe('rewritten');
		await viaProxyBase.remove([key]);
	});

	test('without a token the modes still bite', async () => {
		const anonymous = createStorageClient({
			baseUrl: `${origin}/agents/storage-agent/${CLIENT_PROJECT}`
		}).from(BUCKET);
		await expect(anonymous.list()).rejects.toMatchObject({ status: 401 });
		await expect(anonymous.download(`${run}/notes.txt`)).rejects.toMatchObject({ status: 401 });
	});

	test('a body of unknowable length is refused locally, with the reason', async () => {
		const files = client().from(BUCKET);
		const stream = new ReadableStream();
		// The agent answers 411 for a chunked body; failing here instead means
		// the developer gets a sentence rather than a status code.
		await expect(files.upload(`${run}/stream.txt`, stream as unknown as Blob)).rejects.toThrow(
			/length is known/
		);
	});
});
