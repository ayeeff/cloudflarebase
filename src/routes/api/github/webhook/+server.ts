import { githubAppConfig, verifyWebhookSignature } from '$lib/server/github';
import { forgetInstallation } from '$lib/server/github-connect';
import { handlePush, type PushPayload } from '$lib/server/github-deploy';
import type { RequestHandler } from './$types';

/**
 * GitHub's webhook endpoint (docs/managed-service-design.md, Phase B).
 *
 * PUBLIC BY EXCEPTION, and the only route under `/api` that is: GitHub has no
 * session and never will. The HMAC signature IS the authentication - it is
 * checked before the payload is parsed, and an unsigned or wrongly signed
 * request is a 401 that touches nothing.
 *
 * Answers 200 for anything it understands but does not act on, so GitHub's
 * delivery log shows green for tag pushes and build-mode repositories rather
 * than a wall of red the operator has to learn to ignore.
 */
export const POST: RequestHandler = async ({ request, url, platform }) => {
	const config = githubAppConfig(platform);
	if (!config) {
		return Response.json({ error: 'no GitHub App is configured' }, { status: 404 });
	}

	// The RAW body, not re-serialized JSON: the digest is over exactly the
	// bytes GitHub sent, and JSON.stringify would not reproduce them.
	const raw = await request.text();
	const signed = await verifyWebhookSignature(
		config.webhookSecret,
		raw,
		request.headers.get('x-hub-signature-256')
	);
	if (!signed) {
		return Response.json({ error: 'invalid signature' }, { status: 401 });
	}

	const event = request.headers.get('x-github-event') ?? '';
	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return Response.json({ error: 'invalid payload' }, { status: 400 });
	}

	if (event === 'ping') return Response.json({ ok: true });

	// An uninstalled app must stop deploying immediately - the connections are
	// dead the moment the installation is, and leaving them would strand rows
	// that can never mint a token again.
	if (event === 'installation' && payload.action === 'deleted') {
		const installationId = (payload.installation as { id?: number } | undefined)?.id;
		if (installationId) await forgetInstallation(platform, installationId);
		return Response.json({ ok: true });
	}

	if (event !== 'push') return Response.json({ ok: true, ignored: event });

	const outcomes = await handlePush(platform, payload as PushPayload, url.origin);
	return Response.json({ ok: true, outcomes });
};
