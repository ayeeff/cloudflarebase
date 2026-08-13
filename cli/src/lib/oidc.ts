import { UserError } from './log.js';

/**
 * GitHub Actions OIDC (docs/managed-service-design.md, Phase B).
 *
 * A repository connected through the console's GitHub App deploys with NO
 * stored credential: the workflow asks GitHub for a short-lived token
 * describing the repository it is running in, and the console verifies that
 * against GitHub's public keys. There is nothing to rotate and nothing to
 * leak, which is the same reason this repository publishes to npm this way.
 *
 * The CLI mints it rather than the workflow, so the generated YAML stays a
 * checkout, a build, and a deploy - no token plumbing for anyone to get
 * wrong.
 */

/** Whether this process is inside a GitHub Actions run. */
export function inGithubActions(): boolean {
	return process.env.GITHUB_ACTIONS === 'true';
}

/**
 * Mints an identity token for `audience` (the console's origin - GitHub will
 * mint for any audience asked, so the console checks it to refuse tokens
 * minted for someone else).
 *
 * Null when this is not an Actions run. Throws when it IS one but the token
 * service is unreachable, because the cause is nearly always a missing
 * `id-token: write` permission and silently falling through to "no
 * credential" would report that as a confusing 401 much later.
 */
export async function actionsIdToken(audience: string): Promise<string | null> {
	const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
	const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
	if (!url || !requestToken) {
		if (!inGithubActions()) return null;
		throw new UserError(
			'This workflow cannot mint a GitHub identity token.',
			'Add `permissions: { id-token: write }` to the job, or set CLOUDFLAREBASE_DEPLOY_TOKEN.'
		);
	}

	const response = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, {
		headers: { authorization: `Bearer ${requestToken}`, accept: 'application/json' }
	}).catch((cause: unknown) => {
		throw new UserError(
			"Could not reach GitHub's identity token service.",
			cause instanceof Error ? cause.message : undefined
		);
	});
	if (!response.ok) {
		throw new UserError(
			`GitHub refused to mint an identity token (${response.status}).`,
			'Check that the job declares `permissions: { id-token: write }`.'
		);
	}

	const body = (await response.json().catch(() => null)) as { value?: string } | null;
	if (!body?.value) {
		throw new UserError("GitHub's identity token response carried no token.");
	}
	return body.value;
}
