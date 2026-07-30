import { json } from '@sveltejs/kit';
import { isDemoProjectId } from '$lib/console';
import { chatRequestSchema } from '$lib/schemas/auth';
import { assertProjectId } from '$lib/server/agents';
import {
	chatClientKey,
	demoChatExhausted,
	getChatHistory,
	runCopilot,
	saveChatMessage
} from '$lib/server/copilot';
import { getDb } from '$lib/server/db';
import type { AgentChatReply } from '$lib/agents';
import type { RequestHandler } from './$types';

/**
 * The project copilot's chat endpoint. Formerly a proxy onto the auth agent's
 * /chat; the tool-calling loop now runs here in the dashboard Worker so it can
 * ground answers in BOTH agents (auth and db) over their service bindings.
 * History lives in control-plane D1, keyed per project and per client. The
 * response contract is unchanged: `{ messages }` on GET, AgentChatReply on
 * POST, 400 / 429 / 502 with the same error strings as before.
 */
export const GET: RequestHandler = async (event) => {
	const projectId = assertProjectId(event.params.projectId);
	const db = await getDb(event.platform);
	const clientKey = await chatClientKey(event, projectId);
	return json({ messages: await getChatHistory(db, projectId, clientKey) });
};

export const POST: RequestHandler = async (event) => {
	const projectId = assertProjectId(event.params.projectId);
	const body = chatRequestSchema.safeParse(await event.request.json().catch(() => null));
	if (!body.success) {
		return json({ error: 'question is required' }, { status: 400 });
	}

	const db = await getDb(event.platform);

	// Demo ceiling: /chat is the only route that spends Workers AI neurons and
	// demo projects need no authentication, so one visitor could otherwise
	// starve the whole deployment. Named projects are never capped.
	if (event.locals.demoMode && isDemoProjectId(projectId)) {
		if (await demoChatExhausted(db, projectId)) {
			return json(
				{ error: 'this demo project has reached its daily AI limit - it resets tomorrow' },
				{ status: 429 }
			);
		}
	}

	// Inference is mandatory and failure touches nothing else: no message is
	// persisted unless the model produced an answer.
	if (!event.platform?.env?.AI) {
		return json({ error: 'Workers AI could not answer this request' }, { status: 502 });
	}

	const clientKey = await chatClientKey(event, projectId);
	const history = await getChatHistory(db, projectId, clientKey, 10);

	let outcome;
	try {
		outcome = await runCopilot({
			platform: event.platform,
			origin: event.url.origin,
			projectId,
			question: body.data.question,
			history
		});
	} catch (cause) {
		console.error('copilot inference failed', cause);
		return json({ error: 'Workers AI could not answer this request' }, { status: 502 });
	}

	const createdAt = Date.now();
	const userMessage = await saveChatMessage(
		db,
		projectId,
		clientKey,
		'user',
		body.data.question,
		new Date(createdAt)
	);
	const agentMessage = await saveChatMessage(
		db,
		projectId,
		clientKey,
		'agent',
		outcome.answer,
		new Date(createdAt + 1)
	);

	const reply: AgentChatReply = {
		question: body.data.question,
		topic: 'ai-analysis',
		answer: outcome.answer,
		mode: 'workers-ai',
		model: outcome.model,
		userMessage,
		agentMessage
	};
	return json(reply);
};
