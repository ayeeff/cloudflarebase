/**
 * Auth-agent conveniences over the generic helpers in `$lib/server/agents`.
 * Kept as a shim so the many existing auth proxy routes read unchanged; new
 * agents use the generic helpers with their own registry entry directly.
 */
import { AGENT_REGISTRY } from '$lib/agent-registry';
import {
	agentUrl as genericAgentUrl,
	requireAgent,
	assertProjectId,
	toNativeResponse
} from '$lib/server/agents';

export { assertProjectId, toNativeResponse };

export function requireAuthAgent(platform: App.Platform | undefined) {
	return requireAgent(platform, AGENT_REGISTRY.auth);
}

/**
 * Builds the agent-worker URL for a project sub-path, preserving the caller's
 * origin so Better Auth resolves cookies/redirects against the dashboard.
 */
export function agentUrl(origin: string, projectId: string, subPath: string): string {
	return genericAgentUrl(origin, AGENT_REGISTRY.auth, projectId, subPath);
}
