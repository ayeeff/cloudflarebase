// Deliberately empty: every var, secret, and binding the agent reads is
// declared in some wrangler.jsonc env, so `wrangler types` already emits the
// cross-env union (optional DISPATCH, optional secrets included) and an
// augmentation here would only fight the generated literals. The file stays
// as the documented slot for values that ever live OUTSIDE wrangler config
// (the auth agent's OAuth secrets precedent) - add them here, never by
// hand-editing worker-configuration.d.ts. Never name a sibling `src/env.ts`:
// it would collide and silently kill the ambient augmentation.
