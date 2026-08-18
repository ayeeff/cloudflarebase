import { expect, test } from '@playwright/test';
import { SEED_PROJECT } from './helpers';

/**
 * The OpenAPI document is generated from the same zod schemas the routes
 * validate with, so these assertions are really checking that the generator
 * still produces a usable document - not that someone updated a hand-written
 * file.
 */
test.describe('openapi document', () => {
	test.use({ storageState: { cookies: [], origins: [] } });

	test('is public and describes this project', async ({ request, baseURL }) => {
		const response = await request.get(`/api/projects/${SEED_PROJECT}/openapi.json`);
		expect(response.ok(), 'the document must be fetchable by API tooling').toBeTruthy();

		const doc = await response.json();
		expect(doc.openapi).toMatch(/^3\.1/);
		expect(doc.info.title).toContain(SEED_PROJECT);

		// Addressed at the project's real base URL, not a placeholder host.
		expect(doc.servers[0].url).toBe(`${baseURL}/api/projects/${SEED_PROJECT}`);
	});

	test('covers the public auth surface and the console surface', async ({ request }) => {
		const doc = await (await request.get(`/api/projects/${SEED_PROJECT}/openapi.json`)).json();

		for (const path of [
			'/auth/sign-up/email',
			'/auth/sign-in/email',
			'/auth/sign-in/anonymous',
			'/auth/get-session',
			'/auth/token',
			'/auth/jwks',
			'/config',
			'/overview',
			'/analytics',
			'/chat',
			'/admin/settings',
			'/admin/roles',
			'/admin/users/{userId}',
			'/admin/sessions/{sessionId}',
			'/branches'
		]) {
			expect(doc.paths[path], `${path} should be documented`).toBeTruthy();
		}

		// The branches contribution ships its request and row components too.
		expect(doc.components.schemas.RegistryProject).toBeTruthy();
		expect(doc.components.schemas.CreateBranchRequest).toBeTruthy();
	});

	test('covers the db agent surface', async ({ request }) => {
		const doc = await (await request.get(`/api/projects/${SEED_PROJECT}/openapi.json`)).json();

		// The db agent's registry-driven OpenAPI module contributes its tag, the
		// query route, and the query DSL component.
		const tagNames = doc.tags.map((tag: { name: string }) => tag.name);
		expect(tagNames).toContain('Database');
		expect(doc.paths['/db/collections/{collection}/query']).toBeTruthy();
		expect(doc.components.schemas.DbQuery).toBeTruthy();

		// Aggregations, rules, export/import, and point-in-time restore.
		for (const path of [
			'/db/collections/{collection}/aggregate',
			'/db/collections/{collection}/export',
			'/db/admin/aggregate',
			'/db/admin/collections/{name}/export',
			'/db/admin/collections/{name}/import',
			'/db/admin/collections/{name}/restore',
			'/db/admin/collections/{name}/restore-points',
			'/db/admin/collections/{name}/checkpoint',
			'/db/admin/collections/{name}/bookmark'
		]) {
			expect(doc.paths[path], `${path} should be documented`).toBeTruthy();
		}
		expect(doc.components.schemas.DbValidator).toBeTruthy();
		expect(doc.components.schemas.DbAggregateRequest).toBeTruthy();

		// SQL tables: the typed-row surface and the schema DSL components.
		for (const path of [
			'/db/tables/{table}/rows',
			'/db/tables/{table}/rows/{rowId}',
			'/db/tables/{table}/query',
			'/db/tables/{table}/aggregate',
			'/db/tables/{table}/sql',
			'/db/admin/tables/{name}',
			'/db/admin/tables/{name}/rows/{rowId}'
		]) {
			expect(doc.paths[path], `${path} should be documented`).toBeTruthy();
		}
		expect(doc.components.schemas.DbTableColumn).toBeTruthy();
		expect(doc.components.schemas.DbTableConfig).toBeTruthy();
	});

	/**
	 * The SERVER path (docs/admin-sdk-design.md).
	 *
	 * There is no server SDK by design - the decision was to complete the API
	 * and let the generated reference describe it, rather than hand-maintain a
	 * client that can drift from the routes. That makes this document the
	 * deliverable, so a missing entry here is a missing feature as far as any
	 * user can tell. Six admin routes were absent when this was written, and
	 * one of them (admin table SQL) was the only way to read a table row by id.
	 */
	test('documents the surface a service key opens, and says keys exist', async ({ request }) => {
		const doc = await (await request.get(`/api/projects/${SEED_PROJECT}/openapi.json`)).json();

		// The credential itself. Without a scheme, nothing in the reference tells
		// a reader that server-side access exists at all.
		const serviceKey = doc.components.securitySchemes.serviceKey;
		expect(serviceKey, 'the serviceKey security scheme should be declared').toBeTruthy();
		expect(serviceKey.scheme).toBe('bearer');
		expect(serviceKey.description).toContain('Origin');

		for (const path of [
			// Reading and merging ONE record - absent until the service path work.
			'/db/admin/collections/{name}/documents/{docId}',
			'/db/admin/tables/{name}/sql',
			// Objects: the agent always served these; the console had no route,
			// so a key could configure a bucket and never put a byte in it.
			'/storage/admin/buckets/{bucket}/objects',
			'/storage/admin/buckets/{bucket}/objects/{key}',
			// User management: create/read/update/set-password.
			'/admin/users/{userId}/password'
		]) {
			expect(doc.paths[path], `${path} should be documented`).toBeTruthy();
		}

		// Verbs, not just paths: the item routes existed as write-only before.
		expect(doc.paths['/db/admin/collections/{name}/documents/{docId}'].get).toBeTruthy();
		expect(doc.paths['/db/admin/collections/{name}/documents/{docId}'].patch).toBeTruthy();
		expect(doc.paths['/db/admin/tables/{name}/rows/{rowId}'].get).toBeTruthy();
		expect(doc.paths['/db/admin/tables/{name}/rows/{rowId}'].patch).toBeTruthy();
		expect(doc.paths['/admin/users'].post).toBeTruthy();
		expect(doc.paths['/admin/users/{userId}'].get).toBeTruthy();
		expect(doc.paths['/admin/users/{userId}'].patch).toBeTruthy();

		// Operator routes a key opens must ADVERTISE it, or a reader writes code
		// against a 401 they were never warned about.
		const names = (operation: { security?: Record<string, unknown>[] }) =>
			(operation.security ?? []).flatMap((entry) => Object.keys(entry));
		expect(names(doc.paths['/admin/users'].post)).toContain('serviceKey');
		expect(names(doc.paths['/db/admin/query'].post)).toContain('serviceKey');
		expect(names(doc.paths['/storage/admin/buckets/{bucket}/objects/{key}'].put)).toContain(
			'serviceKey'
		);

		// And routes a key does NOT open must not claim otherwise. /chat is an
		// operator surface that isServiceKeySurface deliberately excludes.
		expect(names(doc.paths['/chat'].post)).not.toContain('serviceKey');
	});

	test('resolves every schema reference it emits', async ({ request }) => {
		const doc = await (await request.get(`/api/projects/${SEED_PROJECT}/openapi.json`)).json();
		const components = doc.components.schemas;

		// A $ref pointing at a component that was never emitted renders as a
		// broken, empty section in the reference - catch it here instead.
		const refs = [...JSON.stringify(doc).matchAll(/"#\/components\/schemas\/([A-Za-z0-9_]+)"/g)];
		expect(refs.length).toBeGreaterThan(0);

		for (const [, name] of refs) {
			expect(components[name], `component ${name} is referenced but missing`).toBeTruthy();
		}

		// Document-level keywords must not leak into component schemas.
		for (const schema of Object.values(components) as Record<string, unknown>[]) {
			expect(schema.$schema).toBeUndefined();
			expect(schema.$id).toBeUndefined();
		}
	});
});
