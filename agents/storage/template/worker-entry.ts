/**
 * Cloudflarebase storage agent entrypoint (added by `cloudflarebase add storage`).
 *
 * Re-exporting the Durable Object classes from YOUR worker's entrypoint is
 * not optional plumbing - it is how the `StorageAgent` and `StorageBucket`
 * bindings in wrangler.jsonc resolve. If your project already has a default
 * export, drop the `default` re-export below and keep your own:
 *
 *   export { StorageAgent, StorageBucket } from '@cloudflarebase/storage';
 */
export { StorageAgent, StorageBucket, default } from '@cloudflarebase/storage';

/**
 * Compile-time binding contract: if wrangler.jsonc is missing a binding the
 * agent needs (or types one wrongly), this line fails your typecheck with the
 * field named - before anything deploys. Run `wrangler types` after changing
 * bindings so `Env` is current.
 */
import type { AssertStorageAgentEnv } from '@cloudflarebase/storage';
export type _StorageAgentBindings = AssertStorageAgentEnv<Env>;
