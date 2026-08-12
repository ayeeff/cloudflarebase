/**
 * Outbound Worker for the dispatch namespaces (wrangler.outbound.jsonc).
 *
 * Every `fetch()` a hosted app makes is re-dispatched here with the
 * parameters the serve path passed (`subdomain` - joinable to a project via
 * the control plane's claims table, so the serve path stays zero-lookup).
 * v1 forwards untouched; Phase C hooks egress metering and policy blocking
 * into exactly this spot without touching user scripts.
 */

interface OutboundEnv {
	/** Dispatch parameter: the subdomain (= script name) that made the fetch. */
	subdomain?: string;
}

export default {
	async fetch(request: Request, _env: OutboundEnv): Promise<Response> {
		return fetch(request);
	},
} satisfies ExportedHandler<OutboundEnv>;
