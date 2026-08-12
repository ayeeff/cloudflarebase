import * as Sentry from '@sentry/cloudflare';
import { getAgentByName, routeAgentRequest } from 'agents';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { HostingAgent as HostingAgentBase } from './agent';
import { appNameSchema, projectIdSchema, subdomainSchema } from './schemas';

/**
 * hosting-agent worker - two roles, decided by hostname (the LiveShard
 * precedent):
 *
 * - **Serving**: requests on the `*.cfbase.dev` wildcard route take the first
 *   host label and `env.DISPATCH.get(hostLabel)` - zero lookup, because the
 *   script name IS the full subdomain. Dispatch never parses the subdomain
 *   into app and branch; the control plane's claims table resolved that at
 *   deploy time. Unclaimed subdomain = no script = branded 404.
 * - **Agent surface** on every other hostname: `/health`, the
 *   service-binding-only `/internal/*` routes (erase fan-in and the console's
 *   claim push - outside /agents/* on purpose: this Worker has no public
 *   route beyond the wildcard, and the serve branch swallows every wildcard
 *   request before dispatch gets here, so /internal is reachable only over
 *   the dashboard's service binding), and `routeAgentRequest` for the
 *   operator surface. Never with `cors: true`.
 */

const sentryOptions = (env: Env) => ({
	dsn: env.SENTRY_DSN,
	environment: env.SENTRY_ENV,
	tracesSampleRate: 0.1,
	enableRpcTracePropagation: true,
});

const DO_RESET_PATTERN = /abort\(\) to reset|durable object reset/i;
function isDurableObjectReset(error: unknown): boolean {
	return DO_RESET_PATTERN.test(error instanceof Error ? error.message : String(error));
}

async function drainUnusedBody(request: Request): Promise<void> {
	try {
		if (request.body && !request.bodyUsed) await request.body.cancel();
	} catch {
		// draining is belt-and-braces, never a failure
	}
}

function brandedNotFound(subdomain: string, domain: string): Response {
	return new Response(
		`<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>Nothing here yet</title>
		<style>
			body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; background: #0a0a0a; color: #fafafa; }
			main { text-align: center; padding: 2rem; }
			code { background: #262626; padding: 0.15rem 0.4rem; border-radius: 0.25rem; }
			a { color: #f6821f; }
		</style>
	</head>
	<body>
		<main>
			<h1>Nothing is deployed at <code>${subdomain}.${domain}</code></h1>
			<p>Claim it with <code>cloudflarebase link</code> and ship with <code>cloudflarebase deploy</code>.</p>
			<p><a href="https://cloudflarebase.com">cloudflarebase.com</a></p>
		</main>
	</body>
</html>`,
		{ status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } },
	);
}

/** What the dispatch path serves under HOSTING_STUB - local dev and e2e have
 * no namespace, so the contract test asserts this page instead. */
function stubPage(subdomain: string, domain: string): Response {
	return new Response(
		`<!doctype html>
<html lang="en">
	<head><meta charset="utf-8" /><title>${subdomain}.${domain} (stub)</title></head>
	<body data-cfbase-stub="${subdomain}">
		<h1>cfbase.dev stub</h1>
		<p>This deployment records apps without a dispatch namespace; <code>${subdomain}.${domain}</code> would serve your deploy in production.</p>
	</body>
</html>`,
		{ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
	);
}

class HostingService extends WorkerEntrypoint<Env> {
	override async fetch(request: Request): Promise<Response> {
		const response = await this.dispatch(request);
		await drainUnusedBody(request);
		return response;
	}

	private async dispatch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// Serving first: on a wildcard host EVERY path belongs to the user's
		// app - our own surfaces exist only on non-serving hostnames.
		const served = await this.serveIfAppHost(request, url);
		if (served) {
			await this.reportServerError(request, url, served);
			return served;
		}

		if (url.pathname === '/health') {
			return Response.json({ service: 'hosting-agent', status: 'ok' });
		}

		const erase = url.pathname.match(/^\/internal\/projects\/([^/]+)$/);
		if (erase && request.method === 'DELETE') {
			const projectId = decodeURIComponent(erase[1]);
			if (!projectIdSchema.safeParse(projectId).success) {
				return Response.json({ error: 'invalid project id' }, { status: 400 });
			}
			const agent = await getAgentByName<Env, HostingAgentBase>(this.env.HostingAgent, projectId);
			try {
				await agent.destroy();
			} catch (error) {
				// The agent's own deferred abort can outrace the RPC reply in
				// production; scripts and storage are already gone by then.
				if (!isDurableObjectReset(error)) throw error;
			}
			return Response.json({ erased: true });
		}

		// The console's claim push: it resolved the subdomain in the control
		// plane and records it here so the deploy route can never be steered to
		// a subdomain this project does not own. Service-binding-only by
		// topology, like the erase route.
		const link = url.pathname.match(/^\/internal\/projects\/([^/]+)\/apps\/([^/]+)$/);
		if (link && request.method === 'PUT') {
			const projectId = decodeURIComponent(link[1]);
			const appName = decodeURIComponent(link[2]);
			const body = (await request.json().catch(() => null)) as { subdomain?: string } | null;
			if (
				!projectIdSchema.safeParse(projectId).success ||
				!appNameSchema.safeParse(appName).success ||
				!subdomainSchema.safeParse(body?.subdomain).success
			) {
				return Response.json({ error: 'invalid claim push' }, { status: 400 });
			}
			const agent = await getAgentByName<Env, HostingAgentBase>(this.env.HostingAgent, projectId);
			const result = await agent.registerApp(appName, body!.subdomain!);
			if ('error' in result) return Response.json(result, { status: 409 });
			return Response.json(result);
		}

		const response =
			(await routeAgentRequest(request, this.env)) ??
			Response.json({ error: 'not found' }, { status: 404 });

		await this.reportServerError(request, url, response);
		return response;
	}

	/**
	 * The dispatch path. Null when the hostname is not a serving host - agent
	 * traffic (service binding, dev ports) falls through to the surfaces
	 * above. Under HOSTING_STUB an `x-cfbase-host` header stands in for the
	 * Host header, because local workerd is dialled by port, not subdomain;
	 * the header is ignored everywhere else.
	 */
	private async serveIfAppHost(request: Request, url: URL): Promise<Response | null> {
		const domain = this.env.HOSTING_DOMAIN;
		if (!domain) return null;

		let host = url.hostname;
		if (this.env.HOSTING_STUB === 'true') {
			const override = request.headers.get('x-cfbase-host');
			if (override) host = override.split(':')[0];
		}

		if (host === domain) {
			const apex = this.env.HOSTING_APEX_REDIRECT;
			return apex ? Response.redirect(apex, 302) : brandedNotFound('www', domain);
		}
		if (!host.endsWith(`.${domain}`)) return null;

		const label = host.slice(0, -(domain.length + 1));
		// Universal SSL covers exactly one wildcard level; anything deeper (or
		// charset-invalid) can never be a claimed subdomain.
		if (label.includes('.') || !subdomainSchema.safeParse(label).success) {
			return brandedNotFound(label.replaceAll('.', '-'), domain);
		}

		if (this.env.HOSTING_STUB === 'true') {
			return stubPage(label, domain);
		}
		if (!this.env.DISPATCH) {
			return brandedNotFound(label, domain);
		}

		const options: DynamicDispatchOptions = {
			// Fixed v1 caps, applied at dispatch (plan-driven in Phase C - which
			// then changes THIS call, never the deployed scripts).
			limits: { cpuMs: 50, subRequests: 50 },
		};
		if (this.env.DISPATCH_OUTBOUND === 'true') {
			// The subdomain rides the outbound parameters - joinable to a project
			// offline via the claims table, so the serve path stays zero-lookup.
			options.outbound = { subdomain: label };
		}

		try {
			const worker = this.env.DISPATCH.get(label, {}, options);
			return await worker.fetch(request);
		} catch (error) {
			if (/worker not found/i.test(error instanceof Error ? error.message : String(error))) {
				return brandedNotFound(label, domain);
			}
			throw error;
		}
	}

	/** Records any 5xx leaving this worker. Never replaces the response. */
	private async reportServerError(request: Request, url: URL, response: Response): Promise<void> {
		if (response.status < 500) return;
		try {
			const body = (await response.clone().text()).slice(0, 2048);
			Sentry.captureMessage(`Hosting agent returned HTTP ${response.status}`, {
				level: 'error',
				tags: { 'http.method': request.method, 'http.status_code': response.status },
				contexts: {
					response: { body, contentType: response.headers.get('content-type') ?? '' },
				},
				extra: { pathname: url.pathname },
			});
		} catch {
			// reporting must never replace the response
		}
	}
}

export const HostingAgent = Sentry.instrumentDurableObjectWithSentry(
	sentryOptions,
	HostingAgentBase,
);

export type { HostingAgentState, HostingAppSummary, HostingDeploySummary } from './agent';
export type { AssertHostingAgentEnv, HostingAgentBindings } from './bindings';

export default Sentry.withSentry(sentryOptions, HostingService);
