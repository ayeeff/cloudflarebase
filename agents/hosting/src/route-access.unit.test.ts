import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ROUTES, gateOperatorRoutes, routeAccess } from './route-access';

/**
 * The gate only ever runs in deployments we do not operate (a consumer's
 * public Worker, where `EXPOSE_OPERATOR_API` is unset), so nothing in the
 * e2e stack exercises it - every environment we run sets the flag and the
 * gate is a no-op. These tests are the coverage for the other shape.
 */

const manifest = JSON.parse(
	// The manifest is written with a BOM; JSON.parse chokes on one.
	// .href, then fileURLToPath: the ambient URL here is workerd's, which is
	// not assignable to node:fs's PathOrFileDescriptor, and a bare pathname
	// would lose the drive letter on Windows.
	readFileSync(
		fileURLToPath(new URL('../cloudflarebase.agent.json', import.meta.url).href),
		'utf8',
	).replace(/^\uFEFF/, ''),
) as { routes: { path: string; access: string }[] };

test('the route table mirrors the manifest', () => {
	assert.deepEqual([...ROUTES], manifest.routes);
});

test('this agent declares no public route', () => {
	assert.equal(
		ROUTES.every((rule) => rule.access === 'operator'),
		true,
	);
	assert.equal(routeAccess('/apps/site/deploys'), 'operator');
	assert.equal(routeAccess('/apps/site/secrets'), 'operator');
	assert.equal(routeAccess('/apps/site/secrets/API_KEY'), 'operator');
	assert.equal(routeAccess('/apps/site/vars'), 'operator');
	assert.equal(routeAccess('/apps/site/build-env'), 'operator');
	assert.equal(routeAccess('/apps/site/analytics'), 'operator');
	assert.equal(routeAccess('/overview'), 'operator');
	assert.equal(routeAccess('/deploys'), 'operator');
	assert.equal(routeAccess('/'), 'operator');
	assert.equal(routeAccess('/whatever-comes-next'), 'operator');
});

const gate = (path: string, env: { EXPOSE_OPERATOR_API?: string } = {}) =>
	gateOperatorRoutes(new URL(`https://app.example${path}`), env);

test('a public Worker refuses every surface', () => {
	for (const path of [
		'/agents/hosting-agent/p1/apps/site/deploys',
		'/agents/hosting-agent/p1/apps/site/secrets',
		'/agents/hosting-agent/p1/overview',
		'/agents/hosting-agent/p1',
		'/internal/projects/p1',
		'/internal/projects/p1/apps/site',
	]) {
		assert.equal(gate(path)?.status, 404, path);
	}
});

test('the flag opens the surface for a control-plane-only Worker', () => {
	assert.equal(
		gate('/agents/hosting-agent/p1/apps/site/deploys', { EXPOSE_OPERATOR_API: 'true' }),
		null,
	);
	assert.equal(gate('/internal/projects/p1/apps/site', { EXPOSE_OPERATOR_API: 'true' }), null);
	assert.equal(
		gate('/agents/hosting-agent/p1/overview', { EXPOSE_OPERATOR_API: '1' })?.status,
		404,
	);
});
