import * as Sentry from '@sentry/cloudflare';
import { Agent, type AgentContext } from 'agents';
import { and, count, desc, eq, gt, lt, or, sql } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import {
	deleteScript,
	deleteScriptSecret,
	deployVars,
	deleteScriptsByTag,
	patchScriptSecret,
	patchScriptVars,
	putScript,
	uploadAssets,
	type AssetFile,
	type CfApi,
	type ModuleFile,
} from './cloudflare';
import * as schema from './db/schema';
import {
	apps,
	appSecrets,
	appVars,
	buildSecrets,
	buildVars,
	deploys,
	type AppRecord,
	type DeployRecord,
} from './db/schema';
import migrations from './migrations';
import {
	DEMO_PROJECT_PATTERN,
	appNameSchema,
	deployCursorSchema,
	deployMetaSchema,
	projectIdSchema,
	secretBodySchema,
	storedVarsSchema,
	subdomainSchema,
	varNameSchema,
	varsBodySchema,
	type DeployMeta,
} from './schemas';
import { gunzip, parseTar, toAssetPaths } from './tar';

/**
 * HostingAgent - one Durable Object per project: the app registry for that
 * project, deploy history, and the orchestration of the Cloudflare API.
 * Control plane, not data plane: code and assets live in the dispatch
 * namespace, and the SERVE path (src/index.ts) never touches this object.
 *
 * Subdomains are pushed by the console after it resolves the claim in the
 * control-plane `app` table - the agent never derives or accepts one from a
 * request, which is what makes the deploy route safe to expose on the
 * operator surface: it can only ever deploy to subdomains the console
 * recorded for THIS project.
 */

const MAX_APPS = 10;
const MAX_DEPLOYS_PER_DAY = 50;
const MAX_VARS_PER_APP = 64;
const MAX_SECRETS_PER_APP = 64;
// Sized for framework output, not just hand-rolled Workers: an OpenNext
// worker bundle routinely passes 10 MB uncompressed, and a Next site blows
// 1000 files on `_next/static` alone. The DO parses deploys in memory, so
// the asset total stays well under the 128 MB isolate limit; Cloudflare's
// own 10 MB-compressed script ceiling still applies at upload.
const MAX_MODULE_BYTES = 20 * 1024 * 1024;
const MAX_ASSET_COUNT = 5000;
const MAX_ASSET_TOTAL_BYTES = 40 * 1024 * 1024;
const MAX_ASSET_FILE_BYTES = 25 * 1024 * 1024;
const RECENT_DEPLOYS = 10;
/** Decompressed ceiling for a direct deploy's tarball. Above the 40 MB asset
 * cap because the archive also carries source we filter out - the deploy
 * itself is still bounded by the asset caps in publish(). */
const MAX_ARCHIVE_BYTES = 96 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 20_000;

/** Cloudflare's Pages/Workers convention files: deploy CONFIGURATION, never
 * content. `_worker.js` doubly so - for any framework whose assets directory
 * is also its build output (SvelteKit, Astro SSR), it is the customer's
 * server bundle, and publishing it would hand out their server source. The
 * CLI filters these too (via .assetsignore); this is the backstop for older
 * CLIs and direct tarball deploys. */
const RESERVED_ROOT_ASSETS = new Set(['/_worker.js', '/_routes.json', '/_headers', '/_redirects']);

export interface HostingAppSummary {
	name: string;
	subdomain: string;
	url: string | null;
	deployCount: number;
	lastDeployAt: string | null;
	createdAt: string;
}

export interface HostingDeploySummary {
	id: string;
	appName: string;
	subdomain: string;
	url: string | null;
	status: 'live' | 'stub';
	hasWorker: boolean;
	assetCount: number;
	assetBytes: number;
	moduleBytes: number;
	createdAt: string;
}

export interface HostingAgentState {
	projectId: string;
	provisionedAt: string | null;
	apps: HostingAppSummary[];
	recentDeploys: HostingDeploySummary[];
	totalDeploys: number;
	/** Bumped on any reported change; dashboards refetch when it moves. */
	rev: number;
}

const EXTENSION_TYPES: Record<string, string> = {
	html: 'text/html',
	css: 'text/css',
	js: 'text/javascript',
	mjs: 'text/javascript',
	json: 'application/json',
	svg: 'image/svg+xml',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	ico: 'image/x-icon',
	txt: 'text/plain',
	xml: 'application/xml',
	pdf: 'application/pdf',
	wasm: 'application/wasm',
	woff: 'font/woff',
	woff2: 'font/woff2',
	map: 'application/json',
	webmanifest: 'application/manifest+json',
};

function contentTypeFor(path: string, provided: string): string {
	if (provided && provided !== 'application/octet-stream') return provided;
	const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
	return EXTENSION_TYPES[extension] ?? 'application/octet-stream';
}

/** Answering a body-bearing request without consuming the body wedges the
 * worker; every route that skips the body drains it before answering. */
async function drainUnusedBody(request: Request): Promise<void> {
	try {
		if (request.body && !request.bodyUsed) await request.body.cancel();
	} catch {
		// draining is belt-and-braces, never a failure
	}
}

export class HostingAgent extends Agent<Env, HostingAgentState> {
	initialState: HostingAgentState = {
		projectId: '',
		provisionedAt: null,
		apps: [],
		recentDeploys: [],
		totalDeploys: 0,
		rev: 0,
	};

	db: DrizzleSqliteDODatabase<typeof schema>;

	constructor(ctx: AgentContext, env: Env) {
		super(ctx, env);
		this.db = drizzle(ctx.storage, { schema });
	}

	async onStart(): Promise<void> {
		// Idempotent - drizzle tracks applied migrations in its own table.
		await migrate(this.db, migrations);
		if (!this.state.projectId) {
			this.setState({
				...this.state,
				projectId: this.name,
				provisionedAt: new Date().toISOString(),
			});
		}
	}

	private get stub(): boolean {
		return this.env.HOSTING_STUB === 'true';
	}

	/** The REST driver's config, or null while any piece is missing. */
	private cfApi(): CfApi | null {
		const { CF_ACCOUNT_ID, CF_HOSTING_API_TOKEN, DISPATCH_NAMESPACE } = this.env;
		if (!CF_ACCOUNT_ID || !CF_HOSTING_API_TOKEN || !DISPATCH_NAMESPACE) return null;
		return {
			accountId: CF_ACCOUNT_ID,
			apiToken: CF_HOSTING_API_TOKEN,
			namespace: DISPATCH_NAMESPACE,
		};
	}

	private appUrl(subdomain: string): string | null {
		return this.env.HOSTING_DOMAIN ? `https://${subdomain}.${this.env.HOSTING_DOMAIN}` : null;
	}

	private toAppSummary(row: AppRecord): HostingAppSummary {
		return {
			name: row.name,
			subdomain: row.subdomain,
			url: this.appUrl(row.subdomain),
			deployCount: row.deployCount,
			lastDeployAt: row.lastDeployAt?.toISOString() ?? null,
			createdAt: row.createdAt.toISOString(),
		};
	}

	private toDeploySummary(row: DeployRecord): HostingDeploySummary {
		return {
			id: row.id,
			appName: row.appName,
			subdomain: row.subdomain,
			url: this.appUrl(row.subdomain),
			status: row.status,
			hasWorker: row.hasWorker,
			assetCount: row.assetCount,
			assetBytes: row.assetBytes,
			moduleBytes: row.moduleBytes,
			createdAt: row.createdAt.toISOString(),
		};
	}

	private async syncState(): Promise<void> {
		const appRows = await this.db.select().from(apps).orderBy(apps.createdAt);
		const recent = await this.db
			.select()
			.from(deploys)
			.orderBy(desc(deploys.createdAt), desc(deploys.id))
			.limit(RECENT_DEPLOYS);
		const [total] = await this.db.select({ value: count() }).from(deploys);
		this.setState({
			...this.state,
			apps: appRows.map((row) => this.toAppSummary(row)),
			recentDeploys: recent.map((row) => this.toDeploySummary(row)),
			totalDeploys: total?.value ?? 0,
			rev: this.state.rev + 1,
		});
	}

	/**
	 * RPC from the worker's service-binding-only `/internal` route: the console
	 * pushes the claim it resolved (control plane owns the global namespace).
	 * Idempotent per app; re-pushing the same claim is a no-op.
	 */
	async registerApp(appName: string, subdomain: string): Promise<{ ok: true } | { error: string }> {
		if (!appNameSchema.safeParse(appName).success) return { error: 'invalid app name' };
		if (!subdomainSchema.safeParse(subdomain).success) return { error: 'invalid subdomain' };

		const [existing] = await this.db.select().from(apps).where(eq(apps.name, appName)).limit(1);
		if (existing) {
			if (existing.subdomain !== subdomain) {
				// The claim table is authoritative; a changed claim (release +
				// re-claim) updates the record.
				await this.db.update(apps).set({ subdomain }).where(eq(apps.name, appName));
				await this.syncState();
			}
			return { ok: true };
		}
		const [{ value: appCount }] = await this.db.select({ value: count() }).from(apps);
		if (appCount >= MAX_APPS) return { error: `projects are limited to ${MAX_APPS} apps` };
		await this.db.insert(apps).values({
			name: appName,
			subdomain,
			createdAt: new Date(),
			deployCount: 0,
		});
		await this.syncState();
		return { ok: true };
	}

	/**
	 * RPC from the worker's service-binding-only route: deletes ONE app - its
	 * namespace script, its deploy history, and its row. The console releases
	 * the subdomain claim only after this succeeds, so a failure here never
	 * frees a name whose script is still serving. Idempotent: an app the DO
	 * does not know (claimed but never deployed - the DO row is only pushed
	 * with the first deploy) still answers ok, because there is nothing here
	 * to remove.
	 */
	async eraseApp(appName: string): Promise<{ ok: true } | { error: string }> {
		if (!appNameSchema.safeParse(appName).success) return { error: 'invalid app name' };

		// Environment rows exist without an `apps` row (a claim-only app can be
		// configured before its first deploy), so they are cleared regardless.
		await this.db.delete(appVars).where(eq(appVars.appName, appName));
		await this.db.delete(appSecrets).where(eq(appSecrets.appName, appName));
		await this.db.delete(buildVars).where(eq(buildVars.appName, appName));
		await this.db.delete(buildSecrets).where(eq(buildSecrets.appName, appName));

		const [app] = await this.db.select().from(apps).where(eq(apps.name, appName)).limit(1);
		if (!app) return { ok: true };

		if (!this.stub) {
			const api = this.cfApi();
			// Configured installs must actually remove the script - answering ok
			// while user code keeps serving would be a lie with a subdomain
			// attached. deleteScript itself tolerates 404 (never deployed).
			if (this.env.DISPATCH && api) {
				await deleteScript(api, app.subdomain);
			}
		}

		await this.db.delete(deploys).where(eq(deploys.appName, appName));
		await this.db.delete(apps).where(eq(apps.name, appName));
		await this.syncState();
		return { ok: true };
	}

	/** Erase fan-in target. Deletes this project's namespace scripts by tag
	 * first - nothing that deletes a project may leave user code running. */
	async destroy(): Promise<void> {
		const api = this.cfApi();
		if (api && !this.stub) {
			// Tag deletion catches every script this project ever uploaded, even
			// ones a lost DO row no longer names.
			await deleteScriptsByTag(api, `pid-${this.name}`);
		}
		await this.ctx.storage.deleteAll();
		// deleteAll leaves the Durable Object's alarm armed; an orphaned alarm
		// would wake the erased object where the SDK's handler dies reading its
		// dropped cf_agents_schedules table.
		await this.ctx.storage.deleteAlarm();
		setTimeout(() => this.ctx.abort(), 0);
	}

	async onRequest(request: Request): Promise<Response> {
		try {
			const response = await this.routeRequest(request);
			await drainUnusedBody(request);
			return response;
		} catch (error) {
			// The Agents SDK's own _tryCatch converts handler exceptions into a
			// bare 500 before Sentry's DO instrumentation sees them - capture the
			// real stack first, then let the SDK answer.
			Sentry.captureException(error);
			throw error;
		}
	}

	private async routeRequest(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (!projectIdSchema.safeParse(this.name).success) {
			return Response.json({ error: 'invalid project id' }, { status: 400 });
		}
		const subPath = url.pathname.match(/\/agents\/[^/]+\/[^/]+(\/.*)?$/)?.[1] ?? '/';

		if (subPath === '/overview' && request.method === 'GET') {
			return Response.json(await this.getOverview());
		}
		if (subPath === '/deploys' && request.method === 'GET') {
			return this.listDeploys(url);
		}
		const deploy = subPath.match(/^\/apps\/([^/]+)\/deploys$/);
		if (deploy && request.method === 'POST') {
			return this.deployApp(decodeURIComponent(deploy[1]), request);
		}
		const vars = subPath.match(/^\/apps\/([^/]+)\/vars$/);
		if (vars && request.method === 'GET') {
			return this.listVars(decodeURIComponent(vars[1]));
		}
		if (vars && request.method === 'PUT') {
			return this.putVars(decodeURIComponent(vars[1]), request);
		}
		const secret = subPath.match(/^\/apps\/([^/]+)\/secrets$/);
		if (secret && request.method === 'GET') {
			return this.listSecrets(decodeURIComponent(secret[1]));
		}
		if (secret && request.method === 'POST') {
			return this.setSecret(decodeURIComponent(secret[1]), request);
		}
		const secretName = subPath.match(/^\/apps\/([^/]+)\/secrets\/([^/]+)$/);
		if (secretName && request.method === 'DELETE') {
			return this.deleteSecret(
				decodeURIComponent(secretName[1]),
				decodeURIComponent(secretName[2]),
			);
		}

		return Response.json({ error: 'not found' }, { status: 404 });
	}

	async getOverview(): Promise<Record<string, unknown>> {
		const appRows = await this.db.select().from(apps).orderBy(apps.createdAt);
		const recent = await this.db
			.select()
			.from(deploys)
			.orderBy(desc(deploys.createdAt), desc(deploys.id))
			.limit(RECENT_DEPLOYS);
		const [total] = await this.db.select({ value: count() }).from(deploys);
		return {
			projectId: this.name,
			provisionedAt: this.state.provisionedAt,
			apps: appRows.map((row) => this.toAppSummary(row)),
			recentDeploys: recent.map((row) => this.toDeploySummary(row)),
			totalDeploys: total?.value ?? 0,
			// Honest config report, so the dashboard can explain instead of 502.
			configured: this.stub || (!!this.env.DISPATCH && this.cfApi() !== null),
			stub: this.stub,
		};
	}

	/** Keyset-paged deploy history (no offsets: rows land mid-scan). */
	private async listDeploys(url: URL): Promise<Response> {
		const appName = url.searchParams.get('app') ?? undefined;
		const cursor = deployCursorSchema.parse(url.searchParams.get('cursor') ?? undefined);
		const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 100);

		const appFilter = appName ? eq(deploys.appName, appName) : undefined;
		let cursorFilter;
		if (cursor) {
			const [ms, id] = cursor.split(':');
			const at = new Date(Number(ms));
			cursorFilter = or(
				lt(deploys.createdAt, at),
				and(eq(deploys.createdAt, at), lt(deploys.id, id)),
			);
		}
		const rows = await this.db
			.select()
			.from(deploys)
			.where(and(appFilter, cursorFilter))
			.orderBy(desc(deploys.createdAt), desc(deploys.id))
			.limit(limit + 1);
		const page = rows.slice(0, limit);
		const next = rows.length > limit ? page[page.length - 1] : null;
		const [total] = await this.db
			.select({ value: count() })
			.from(deploys)
			.where(appFilter ?? sql`1 = 1`);
		return Response.json({
			deploys: page.map((row) => this.toDeploySummary(row)),
			total: total?.value ?? 0,
			cursor: next ? `${next.createdAt.getTime()}:${next.id}` : null,
		});
	}

	/**
	 * The checks every deploy passes before its body is even read: no demo
	 * hosting, the app must carry a console-pushed claim, and the daily
	 * ceiling. Returns the app row, or the Response to send instead.
	 */
	private async gateDeploy(appName: string): Promise<AppRecord | Response> {
		if (DEMO_PROJECT_PATTERN.test(this.name)) {
			// Belt to the console's braces: no demo hosting, ever.
			return Response.json({ error: 'demo projects cannot deploy apps' }, { status: 403 });
		}
		const [app] = await this.db.select().from(apps).where(eq(apps.name, appName)).limit(1);
		if (!app) {
			// The console pushes the claim before forwarding a deploy; reaching
			// this without one means the agent surface was dialled directly.
			return Response.json(
				{ error: 'app is not linked - deploy through the console or the CLI' },
				{ status: 409 },
			);
		}

		const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
		const [recent] = await this.db
			.select({ value: count() })
			.from(deploys)
			.where(gt(deploys.createdAt, since));
		if ((recent?.value ?? 0) >= MAX_DEPLOYS_PER_DAY) {
			return Response.json(
				{ error: `projects are limited to ${MAX_DEPLOYS_PER_DAY} deploys per day` },
				{ status: 429 },
			);
		}
		return app;
	}

	private async deployApp(appName: string, request: Request): Promise<Response> {
		const gate = await this.gateDeploy(appName);
		if (gate instanceof Response) return gate;
		const app = gate;

		let form: FormData;
		try {
			form = await request.formData();
		} catch {
			return Response.json({ error: 'expected a multipart deploy body' }, { status: 400 });
		}

		const metaRaw = form.get('meta');
		const meta = deployMetaSchema.safeParse(
			typeof metaRaw === 'string' ? JSON.parse(metaRaw || 'null') : null,
		);
		if (!meta.success) {
			return Response.json({ error: 'invalid deploy meta' }, { status: 400 });
		}

		const modules: ModuleFile[] = [];
		const assets: AssetFile[] = [];
		for (const [key, value] of form.entries()) {
			if (typeof value === 'string') continue;
			const bytes = new Uint8Array(await value.arrayBuffer());
			if (key.startsWith('module:')) {
				const name = key.slice('module:'.length);
				if (!/^[A-Za-z0-9._-]+\.(?:js|mjs)$/.test(name)) {
					return Response.json({ error: `invalid module name "${name}"` }, { status: 400 });
				}
				modules.push({ name, bytes });
			} else if (key.startsWith('asset:')) {
				const path = key.slice('asset:'.length);
				if (!path.startsWith('/') || path.includes('..') || path.length > 512) {
					return Response.json({ error: `invalid asset path "${path}"` }, { status: 400 });
				}
				assets.push({ path, bytes, contentType: contentTypeFor(path, value.type) });
			}
		}

		// Size ceilings are enforced in publish(), so both deploy paths meet
		// exactly the same limits.
		return this.publish(appName, app, {
			modules,
			assets,
			meta: meta.data,
			origin: new URL(request.url).origin,
		});
	}

	/**
	 * Uploads a prepared deploy and records it. Shared by the multipart route
	 * (the CLI's path) and the git route (a push webhook), so the caps and the
	 * bookkeeping can never diverge between them - the two differ only in
	 * where the bytes came from.
	 */
	private async publish(
		appName: string,
		app: AppRecord,
		input: { modules: ModuleFile[]; assets: AssetFile[]; meta: DeployMeta; origin: string },
	): Promise<Response> {
		const { modules, meta } = input;
		// Root-level convention files never publish, whatever path they arrived
		// by. A deploy REDUCED to nothing by this (a lone _worker.js) falls
		// through to the honest "nothing to deploy" below.
		const assets = input.assets.filter((asset) => !RESERVED_ROOT_ASSETS.has(asset.path));
		const moduleBytes = modules.reduce((total, module) => total + module.bytes.length, 0);
		const assetBytes = assets.reduce((total, asset) => total + asset.bytes.length, 0);

		if (moduleBytes > MAX_MODULE_BYTES) {
			return Response.json(
				{ error: `the Worker bundle exceeds ${MAX_MODULE_BYTES / 1024 / 1024} MB` },
				{ status: 400 },
			);
		}
		if (assets.length > MAX_ASSET_COUNT) {
			return Response.json(
				{ error: `deploys are limited to ${MAX_ASSET_COUNT} assets` },
				{ status: 400 },
			);
		}
		if (assetBytes > MAX_ASSET_TOTAL_BYTES) {
			return Response.json(
				{ error: `assets exceed ${MAX_ASSET_TOTAL_BYTES / 1024 / 1024} MB` },
				{ status: 400 },
			);
		}
		if (assets.some((asset) => asset.bytes.length > MAX_ASSET_FILE_BYTES)) {
			return Response.json(
				{ error: `an asset exceeds ${MAX_ASSET_FILE_BYTES / 1024 / 1024} MB` },
				{ status: 400 },
			);
		}
		if (!modules.length && !assets.length) {
			return Response.json({ error: 'nothing to deploy' }, { status: 400 });
		}
		if (modules.length && !meta.mainModule) {
			return Response.json({ error: 'deploys with modules need meta.mainModule' }, { status: 400 });
		}
		if (meta.mainModule && !modules.some((module) => module.name === meta.mainModule)) {
			return Response.json({ error: 'meta.mainModule is not among the modules' }, { status: 400 });
		}

		// Stored console vars sit between the CLI's meta.vars and the platform's:
		// the console is the canonical editor, so its values win over a stale
		// cloudflarebase.json, and the platform's facts stay uncontestable on top
		// (deployVars applies them last).
		const storedRows = await this.db.select().from(appVars).where(eq(appVars.appName, appName));
		const storedVars = Object.fromEntries(storedRows.map((row) => [row.name, row.value]));

		if (!this.stub) {
			const api = this.cfApi();
			if (!this.env.DISPATCH || !api) {
				return Response.json(
					{
						error:
							'hosting is not configured - this install needs a Workers for Platforms dispatch namespace (DISPATCH binding, DISPATCH_NAMESPACE, CF_ACCOUNT_ID, CF_HOSTING_API_TOKEN)',
					},
					{ status: 503 },
				);
			}
			try {
				const assetsJwt = await uploadAssets(api, app.subdomain, this.name, assets);
				await putScript(api, app.subdomain, {
					projectId: this.name,
					appName,
					mainModule: meta.mainModule,
					modules,
					compatibilityDate: meta.compatibilityDate ?? '2026-07-10',
					compatibilityFlags: meta.compatibilityFlags ?? [],
					assetsJwt,
					notFoundHandling: meta.notFoundHandling,
					vars: deployVars({ ...(meta.vars ?? {}), ...storedVars }, this.name, input.origin),
				});
			} catch (cause) {
				Sentry.captureException(cause, {
					tags: { operation: 'hosting-deploy', projectId: this.name },
				});
				const message = cause instanceof Error ? cause.message : 'upload failed';
				return Response.json({ error: `deploy failed - ${message}` }, { status: 502 });
			}
		}

		const record: DeployRecord = {
			id: crypto.randomUUID(),
			appName,
			subdomain: app.subdomain,
			status: this.stub ? 'stub' : 'live',
			hasWorker: modules.length > 0,
			assetCount: assets.length,
			assetBytes,
			moduleBytes,
			createdAt: new Date(),
		};
		await this.db.insert(deploys).values(record);
		await this.db
			.update(apps)
			.set({
				deployCount: app.deployCount + 1,
				lastDeployAt: record.createdAt,
				// Snapshot of what the CLI declared, so a later console var edit can
				// rebuild the script's full plain_text set without the CLI present.
				lastDeployVars: JSON.stringify(meta.vars ?? {}),
			})
			.where(eq(apps.name, appName));
		await this.syncState();

		return Response.json(
			{
				deploy: this.toDeploySummary(record),
				subdomain: app.subdomain,
				url: this.appUrl(app.subdomain),
			},
			{ status: 201 },
		);
	}

	/**
	 * Deploys a repository tarball - the no-runner path (Phase B, direct
	 * deploys). The console resolved the claim and the download URL, so this
	 * receives a plain URL and never holds a GitHub credential.
	 *
	 * Only static assets: a repository that needs a build is a build-mode
	 * connection and arrives through the ordinary multipart route instead.
	 */
	async gitDeploy(input: {
		appName: string;
		tarballUrl: string;
		assetsDir: string;
		origin: string;
	}): Promise<{ status: number; json: string }> {
		const gate = await this.gateDeploy(input.appName);
		if (gate instanceof Response) {
			return { status: gate.status, json: await gate.text() };
		}

		let assets: AssetFile[];
		try {
			const response = await fetch(input.tarballUrl);
			if (!response.ok || !response.body) {
				return {
					status: 502,
					json: JSON.stringify({ error: 'could not download the repository archive' }),
				};
			}
			const buffer = await gunzip(response.body, MAX_ARCHIVE_BYTES);
			const entries = parseTar(buffer, MAX_ARCHIVE_FILES);
			assets = toAssetPaths(entries, input.assetsDir).map(({ path, bytes }) => ({
				path,
				bytes,
				contentType: contentTypeFor(path, ''),
			}));
		} catch (cause) {
			Sentry.captureException(cause, {
				tags: { operation: 'hosting-git-deploy', projectId: this.name },
			});
			const message = cause instanceof Error ? cause.message : 'could not read the archive';
			return { status: 400, json: JSON.stringify({ error: message }) };
		}

		if (!assets.length) {
			return {
				status: 400,
				json: JSON.stringify({
					error: input.assetsDir
						? `nothing to deploy - "${input.assetsDir}" is empty or missing in this commit`
						: 'nothing to deploy - the repository has no publishable files',
				}),
			};
		}

		const response = await this.publish(input.appName, gate, {
			modules: [],
			assets,
			meta: { notFoundHandling: 'single-page-application' },
			origin: input.origin,
		});
		return { status: response.status, json: await response.text() };
	}

	private async setSecret(appName: string, request: Request): Promise<Response> {
		const [app] = await this.db.select().from(apps).where(eq(apps.name, appName)).limit(1);
		if (!app) return Response.json({ error: 'no such app' }, { status: 404 });
		const body = secretBodySchema.safeParse(await request.json().catch(() => null));
		if (!body.success) {
			return Response.json({ error: 'invalid secret body' }, { status: 400 });
		}
		const name = body.data.name;

		const [existing] = await this.db
			.select()
			.from(appSecrets)
			.where(and(eq(appSecrets.appName, appName), eq(appSecrets.name, name)))
			.limit(1);
		if (!existing) {
			const [{ value: secretCount }] = await this.db
				.select({ value: count() })
				.from(appSecrets)
				.where(eq(appSecrets.appName, appName));
			if (secretCount >= MAX_SECRETS_PER_APP) {
				return Response.json(
					{ error: `apps are limited to ${MAX_SECRETS_PER_APP} secrets` },
					{ status: 400 },
				);
			}
		}

		if (!this.stub) {
			// Write-through: the value goes to Cloudflare's script settings and is
			// never at rest here. Stub mode skips the call (there is no script) but
			// still records the name, so local dev and e2e exercise the whole
			// list/delete contract.
			const api = this.cfApi();
			if (!api) {
				return Response.json({ error: 'hosting is not configured' }, { status: 503 });
			}
			try {
				await patchScriptSecret(api, app.subdomain, name, body.data.value);
			} catch (cause) {
				Sentry.captureException(cause, {
					tags: { operation: 'hosting-secret', projectId: this.name },
				});
				return Response.json({ error: 'setting the secret failed' }, { status: 502 });
			}
		}

		const now = new Date();
		await this.db
			.insert(appSecrets)
			.values({ appName, name, createdAt: now, updatedAt: now })
			.onConflictDoUpdate({
				target: [appSecrets.appName, appSecrets.name],
				set: { updatedAt: now },
			});
		return Response.json({ ok: true });
	}

	/** Secret NAMES and timestamps - the values live at Cloudflare, not here. */
	private async listSecrets(appName: string): Promise<Response> {
		if (!appNameSchema.safeParse(appName).success) {
			return Response.json({ error: 'invalid app name' }, { status: 400 });
		}
		const rows = await this.db
			.select()
			.from(appSecrets)
			.where(eq(appSecrets.appName, appName))
			.orderBy(appSecrets.name);
		return Response.json({
			secrets: rows.map((row) => ({
				name: row.name,
				createdAt: row.createdAt.toISOString(),
				updatedAt: row.updatedAt.toISOString(),
			})),
		});
	}

	/** Idempotent: the name row goes regardless; the script binding is removed
	 * when there is a script to remove it from (404-tolerant at the API). */
	private async deleteSecret(appName: string, name: string): Promise<Response> {
		if (!appNameSchema.safeParse(appName).success) {
			return Response.json({ error: 'invalid app name' }, { status: 400 });
		}
		if (!varNameSchema.safeParse(name).success) {
			return Response.json({ error: 'invalid secret name' }, { status: 400 });
		}
		if (!this.stub) {
			const [app] = await this.db.select().from(apps).where(eq(apps.name, appName)).limit(1);
			const api = this.cfApi();
			if (app && api) {
				try {
					await deleteScriptSecret(api, app.subdomain, name);
				} catch (cause) {
					Sentry.captureException(cause, {
						tags: { operation: 'hosting-secret-delete', projectId: this.name },
					});
					// The row stays - the console keeps showing a secret that is
					// still set, which is the honest state.
					return Response.json({ error: 'deleting the secret failed' }, { status: 502 });
				}
			}
		}
		await this.db
			.delete(appSecrets)
			.where(and(eq(appSecrets.appName, appName), eq(appSecrets.name, name)));
		return Response.json({ ok: true });
	}

	/** Stored runtime vars. No `apps`-row requirement: a claim-only app can be
	 * configured before its first deploy, which then picks the vars up. */
	private async listVars(appName: string): Promise<Response> {
		if (!appNameSchema.safeParse(appName).success) {
			return Response.json({ error: 'invalid app name' }, { status: 400 });
		}
		return Response.json({ vars: await this.varSummaries(appName) });
	}

	private async varSummaries(
		appName: string,
	): Promise<{ name: string; value: string; createdAt: string; updatedAt: string }[]> {
		const rows = await this.db
			.select()
			.from(appVars)
			.where(eq(appVars.appName, appName))
			.orderBy(appVars.name);
		return rows.map((row) => ({
			name: row.name,
			value: row.value,
			createdAt: row.createdAt.toISOString(),
			updatedAt: row.updatedAt.toISOString(),
		}));
	}

	/**
	 * Replace-the-set: the console form submits the whole table, so absent
	 * names are deletions. The store always succeeds first; patching the live
	 * script is best-effort and reported (`patched` / `warning`), never a way
	 * to lose an edit to a transient API failure.
	 */
	private async putVars(appName: string, request: Request): Promise<Response> {
		if (!appNameSchema.safeParse(appName).success) {
			return Response.json({ error: 'invalid app name' }, { status: 400 });
		}
		const body = varsBodySchema.safeParse(await request.json().catch(() => null));
		if (!body.success) {
			return Response.json({ error: 'invalid vars body' }, { status: 400 });
		}
		const wanted = body.data.vars;
		if (Object.keys(wanted).length > MAX_VARS_PER_APP) {
			return Response.json(
				{ error: `apps are limited to ${MAX_VARS_PER_APP} variables` },
				{ status: 400 },
			);
		}

		const now = new Date();
		const existing = await this.db.select().from(appVars).where(eq(appVars.appName, appName));
		const current = new Map(existing.map((row) => [row.name, row]));
		for (const row of existing) {
			if (!(row.name in wanted)) {
				await this.db
					.delete(appVars)
					.where(and(eq(appVars.appName, appName), eq(appVars.name, row.name)));
			}
		}
		for (const [name, value] of Object.entries(wanted)) {
			const row = current.get(name);
			if (!row) {
				await this.db
					.insert(appVars)
					.values({ appName, name, value, createdAt: now, updatedAt: now });
			} else if (row.value !== value) {
				await this.db
					.update(appVars)
					.set({ value, updatedAt: now })
					.where(and(eq(appVars.appName, appName), eq(appVars.name, name)));
			}
		}

		let patched = false;
		let warning: string | undefined;
		const [app] = await this.db.select().from(apps).where(eq(apps.name, appName)).limit(1);
		const api = this.cfApi();
		if (!this.stub && app?.lastDeployAt && api) {
			// The last CLI-declared vars ride the stored snapshot; the platform's
			// come out on top, same order as a deploy.
			let cliVars: Record<string, string> = {};
			try {
				cliVars = storedVarsSchema.parse(JSON.parse(app.lastDeployVars ?? '{}'));
			} catch {
				// An unreadable snapshot degrades to "no CLI vars".
			}
			try {
				await patchScriptVars(
					api,
					app.subdomain,
					deployVars({ ...cliVars, ...wanted }, this.name, new URL(request.url).origin),
				);
				patched = true;
			} catch (cause) {
				Sentry.captureException(cause, {
					tags: { operation: 'hosting-vars', projectId: this.name },
				});
				warning = 'saved, but updating the live script failed - the next deploy applies them';
			}
		}

		return Response.json({
			vars: await this.varSummaries(appName),
			patched,
			...(warning ? { warning } : {}),
		});
	}
}
