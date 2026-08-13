/**
 * Cloudflarebase hosting agent entrypoint (added by `cloudflarebase add hosting`).
 *
 * Re-exporting the Durable Object class from YOUR worker's entrypoint is not
 * optional plumbing - it is how the `HostingAgent` binding in wrangler.jsonc
 * resolves. If your project already has a default export, drop the `default`
 * re-export below and keep your own:
 *
 *   export { HostingAgent } from '@cloudflarebase/hosting';
 */
export { HostingAgent, default } from '@cloudflarebase/hosting';

/**
 * Compile-time binding contract: if wrangler.jsonc is missing a binding the
 * agent needs (or types one wrongly), this line fails your typecheck with the
 * field named - before anything deploys. Run `wrangler types` after changing
 * bindings so `Env` is current.
 */
import type { AssertHostingAgentEnv } from '@cloudflarebase/hosting';
export type _HostingAgentBindings = AssertHostingAgentEnv<Env>;
