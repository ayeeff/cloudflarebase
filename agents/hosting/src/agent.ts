import * as Sentry from '@sentry/cloudflare';
import { Agent, type AgentContext } from 'agents';
import { and, count, desc, eq, gt, lt, or, sql } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import {
	deleteScriptsByTag,
	patchScriptSecret,
	putScript,
	uploadAssets,
	type AssetFile,
	type CfApi,
	type ModuleFile,
} from './cloudflare';
import * as schema from './db/schema';
import { apps, deploys, type AppRecord, type DeployRecord } from './db/schema';
import migrations from './migrations';
import {
	DEMO_PROJECT_PATTERN,
	appNameSchema,
	deployCursorSchema,
	deployMetaSchema,
	projectIdSchema,
	secretBodySchema,
	subdomainSchema,
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

const MAX_APPS = 2;
const MAX_DEPLOYS_PER_DAY = 50;
const MAX_MODULE_BYTES = 5 * 1024 * 1024;
const MAX_ASSET_COUNT = 1000;
const MAX_ASSET_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_ASSET_FILE_BYTES = 10 * 1024 * 1024;
const RECENT_DEPLOYS = 10;
/** Decompressed ceiling for a direct deploy's tarball. Above the 25 MB asset
 * cap because the archive also carries source we filter out - the deploy
 * itself is still bounded by the asset caps in publish(). */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 20_000;

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
		const secret = subPath.match(/^\/apps\/([^/]+)\/secrets$/);
		if (secret && request.method === 'POST') {
			return this.setSecret(decodeURIComponent(secret[1]), request);
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
		const { modules, assets, meta } = input;
		const moduleBytes = modules.reduce((total, module) => total + module.bytes.length, 0);
		const assetBytes = assets.reduce((total, asset) => total + asset.bytes.length, 0);

		if (moduleBytes > MAX_MODULE_BYTES) {
			return Response.json({ error: 'the Worker bundle exceeds 5 MB' }, { status: 400 });
		}
		if (assets.length > MAX_ASSET_COUNT) {
			return Response.json(
				{ error: `deploys are limited to ${MAX_ASSET_COUNT} assets` },
				{ status: 400 },
			);
		}
		if (assetBytes > MAX_ASSET_TOTAL_BYTES) {
			return Response.json({ error: 'assets exceed 25 MB' }, { status: 400 });
		}
		if (assets.some((asset) => asset.bytes.length > MAX_ASSET_FILE_BYTES)) {
			return Response.json({ error: 'an asset exceeds 10 MB' }, { status: 400 });
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
					vars: {
						...meta.vars,
						// Injected last so the SDK vars always win.
						PROJECT_ID: this.name,
						CLOUDFLAREBASE_URL: input.origin,
					},
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
			.set({ deployCount: app.deployCount + 1, lastDeployAt: record.createdAt })
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
		if (this.stub) {
			// Stub deploys never reach the namespace, so there is no script to
			// patch - honest 501, mirroring PITR in local dev.
			return Response.json({ error: 'secrets are unavailable in stub mode' }, { status: 501 });
		}
		const api = this.cfApi();
		if (!api) {
			return Response.json({ error: 'hosting is not configured' }, { status: 503 });
		}
		try {
			await patchScriptSecret(api, app.subdomain, body.data.name, body.data.value);
		} catch (cause) {
			Sentry.captureException(cause, {
				tags: { operation: 'hosting-secret', projectId: this.name },
			});
			return Response.json({ error: 'setting the secret failed' }, { status: 502 });
		}
		return Response.json({ ok: true });
	}
}
