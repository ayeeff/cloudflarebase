/**
 * The project copilot: a console-orchestrated Workers AI tool loop.
 *
 * The loop runs in the dashboard Worker (this is the control plane, and the
 * only place that can see EVERY agent) and answers from live project data by
 * calling the auth and db agents over their service bindings. Conversation
 * history is control-plane state in D1 - the old per-agent transcript in the
 * auth Durable Object is deliberately not migrated.
 *
 * The response contract mirrors the auth agent's retired /chat surface
 * exactly (AgentChatMessage / AgentChatReply, 400 / 429 / 502 shapes), so the
 * dashboard pane and the e2e specs keep working unchanged.
 */
import { and, count, desc, eq, gte, lt } from 'drizzle-orm';
import { z } from 'zod';
import { AGENT_REGISTRY, type AppAgentEntry } from '$lib/agent-registry';
import { dbQuerySchema, type AgentChatMessage } from '$lib/agents';
import { agentUrl, requireAgent } from '$lib/server/agents';
import { chatMessage } from '$lib/server/db/schema';
import type { ControlPlaneDatabase } from '$lib/server/db';
import type { RequestEvent } from '@sveltejs/kit';

const DEFAULT_CHAT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/** Tool budget per question; a fifth call runs without tools to force text. */
const MAX_TOOL_ROUNDS = 4;

/** Tool output ceiling so one large collection cannot flood the context. */
const TOOL_RESULT_MAX_CHARS = 6_000;

/** Mirrors the auth agent's demo ceiling: neurons are an account-level quota. */
export const DEMO_MAX_CHAT_PER_DAY = 50;

/** Demo DOs self-erase; this is the matching retention backstop for D1 rows. */
const DEMO_CHAT_RETENTION_DAYS = 30;

/**
 * Identifies a conversation thread. Operators converse under their user id
 * (stable across devices); anonymous demo visitors under a project-scoped
 * SHA-256 of their connecting IP. Raw IPs are never stored - the same privacy
 * invariant the auth agent's chat kept.
 */
export async function chatClientKey(event: RequestEvent, projectId: string): Promise<string> {
	const operator = event.locals.consoleUser;
	if (operator) return operator.id;

	let address = event.request.headers.get('cf-connecting-ip');
	if (!address) {
		try {
			address = event.getClientAddress();
		} catch {
			address = 'local';
		}
	}
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(`${projectId}:${address}`)
	);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Last `limit` messages for the thread, oldest first. */
export async function getChatHistory(
	db: ControlPlaneDatabase,
	projectId: string,
	clientKey: string,
	limit = 50
): Promise<AgentChatMessage[]> {
	const rows = await db
		.select()
		.from(chatMessage)
		.where(and(eq(chatMessage.projectId, projectId), eq(chatMessage.clientKey, clientKey)))
		.orderBy(desc(chatMessage.createdAt))
		.limit(limit);
	return rows.reverse().map((message) => ({
		id: message.id,
		role: message.role,
		content: message.content,
		createdAt: message.createdAt.toISOString()
	}));
}

export async function saveChatMessage(
	db: ControlPlaneDatabase,
	projectId: string,
	clientKey: string,
	role: AgentChatMessage['role'],
	content: string,
	createdAt: Date
): Promise<AgentChatMessage> {
	const message = { id: crypto.randomUUID(), projectId, clientKey, role, content, createdAt };
	await db.insert(chatMessage).values(message);
	return { id: message.id, role, content, createdAt: createdAt.toISOString() };
}

/**
 * Demo ceiling + retention, both keyed on the project. Purges rows older than
 * the retention window (demo Durable Objects self-erase but D1 rows would
 * outlive them), then counts today's questions against the daily cap.
 */
export async function demoChatExhausted(
	db: ControlPlaneDatabase,
	projectId: string
): Promise<boolean> {
	await db
		.delete(chatMessage)
		.where(
			and(
				eq(chatMessage.projectId, projectId),
				lt(chatMessage.createdAt, new Date(Date.now() - DEMO_CHAT_RETENTION_DAYS * 86_400_000))
			)
		);

	const startOfUtcDay = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
	const [row] = await db
		.select({ questions: count() })
		.from(chatMessage)
		.where(
			and(
				eq(chatMessage.projectId, projectId),
				eq(chatMessage.role, 'user'),
				gte(chatMessage.createdAt, startOfUtcDay)
			)
		);
	return Number(row?.questions ?? 0) >= DEMO_MAX_CHAT_PER_DAY;
}

// ---------------------------------------------------------------------------
// Tool registry: read-only views over both agents, reached exactly like the
// dashboard proxies reach them - agentUrl() + the registry's service binding.

interface ToolContext {
	platform: App.Platform | undefined;
	origin: string;
	projectId: string;
}

interface CopilotTool {
	name: string;
	description: string;
	parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
	execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
}

async function fetchAgentTool(
	ctx: ToolContext,
	entry: AppAgentEntry,
	subPath: string,
	init?: RequestInit
): Promise<string> {
	const agent = requireAgent(ctx.platform, entry);
	const response = await agent.fetch(agentUrl(ctx.origin, entry, ctx.projectId, subPath), init);
	const text = await (response as unknown as Response).text();
	if (!response.ok) {
		return `request failed with status ${response.status}: ${truncate(text, 500)}`;
	}
	return truncate(text, TOOL_RESULT_MAX_CHARS);
}

const dbQueryArgsSchema = z.object({
	collection: z.string().min(1).max(64),
	limit: z.number().int().min(1).max(20).optional(),
	where: dbQuerySchema.shape.where,
	orderBy: dbQuerySchema.shape.orderBy
});

const COPILOT_TOOLS: CopilotTool[] = [
	{
		name: 'auth_overview',
		description:
			"The project's current auth state: every user (name, email, role, providers, anonymous or registered), active sessions (with country and user agent), the role registry, allowed origins, and recent auth activity events.",
		parameters: { type: 'object', properties: {} },
		execute: (_args, ctx) => fetchAgentTool(ctx, AGENT_REGISTRY.auth, '/overview')
	},
	{
		name: 'auth_analytics',
		description:
			'Aggregated auth analytics: DAU/WAU/MAU, total vs registered vs anonymous users, sign-in providers, session countries, daily sign-up and sign-in activity, and event counts for the last 24 hours.',
		parameters: { type: 'object', properties: {} },
		execute: (_args, ctx) =>
			fetchAgentTool(ctx, AGENT_REGISTRY.auth, '/analytics?timeZone=Etc%2FUTC')
	},
	{
		name: 'db_overview',
		description:
			"The project's database state: every collection with its name, document count, read/write access modes (public, auth, or owner), total documents, and recent database activity events.",
		parameters: { type: 'object', properties: {} },
		execute: (_args, ctx) => fetchAgentTool(ctx, AGENT_REGISTRY.db, '/overview')
	},
	{
		name: 'db_query',
		description:
			'Read actual documents from one collection (up to 20). Use db_overview first to learn the collection names. Supports filtering and ordering over dotted JSON field paths.',
		parameters: {
			type: 'object',
			properties: {
				collection: {
					type: 'string',
					description: 'Collection name, exactly as db_overview reports it.'
				},
				limit: { type: 'number', description: 'Maximum documents to return (1-20, default 10).' },
				where: {
					type: 'array',
					description:
						'Optional AND-combined filters, e.g. [{"field":"status","op":"==","value":"active"}]. Ops: ==, !=, <, <=, >, >=, in, array-contains.',
					items: {
						type: 'object',
						properties: {
							field: { type: 'string' },
							op: { type: 'string' },
							value: { description: 'String, number, boolean, null, or an array for "in".' }
						},
						required: ['field', 'op', 'value']
					}
				},
				orderBy: {
					type: 'array',
					description: 'Optional sort, e.g. [{"field":"createdAt","direction":"desc"}].',
					items: {
						type: 'object',
						properties: {
							field: { type: 'string' },
							direction: { type: 'string', enum: ['asc', 'desc'] }
						},
						required: ['field', 'direction']
					}
				}
			},
			required: ['collection']
		},
		execute: async (args, ctx) => {
			const parsed = dbQueryArgsSchema.safeParse(args);
			if (!parsed.success) {
				const issues = parsed.error.issues
					.map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
					.join('; ');
				return `invalid arguments - ${issues}`;
			}
			const { collection, where, orderBy } = parsed.data;
			const query = {
				limit: Math.min(parsed.data.limit ?? 10, 20),
				...(where ? { where } : {}),
				...(orderBy ? { orderBy } : {})
			};
			return fetchAgentTool(ctx, AGENT_REGISTRY.db, '/admin/query', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ collection, query })
			});
		}
	}
];

// ---------------------------------------------------------------------------
// The Workers AI function-calling loop.

interface LoopMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	name?: string;
}

/**
 * Narrow structural view of the AI binding. The generated `Ai["run"]` types
 * are keyed per model id, which a runtime-configured CHAT_MODEL cannot
 * satisfy; the response is zod-parsed instead of trusted.
 */
interface AiRunner {
	run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

const aiResultSchema = z.object({
	response: z.string().nullish(),
	tool_calls: z.array(z.unknown()).nullish()
});

const directCallSchema = z.object({ name: z.string(), arguments: z.unknown().optional() });
const nestedCallSchema = z.object({ function: directCallSchema });

interface NormalizedToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

/** Accepts both tool-call shapes Workers AI models emit; drops malformed entries. */
function normalizeToolCalls(raw: unknown[] | null | undefined): NormalizedToolCall[] {
	const calls: NormalizedToolCall[] = [];
	for (const entry of raw ?? []) {
		const direct = directCallSchema.safeParse(entry);
		const nested = nestedCallSchema.safeParse(entry);
		const call = direct.success ? direct.data : nested.success ? nested.data.function : null;
		if (!call) continue;
		let args = call.arguments;
		if (typeof args === 'string') {
			try {
				args = JSON.parse(args);
			} catch {
				args = {};
			}
		}
		calls.push({
			name: call.name,
			arguments:
				args && typeof args === 'object' && !Array.isArray(args)
					? (args as Record<string, unknown>)
					: {}
		});
	}
	return calls;
}

async function executeToolCall(call: NormalizedToolCall, ctx: ToolContext): Promise<string> {
	const tool = COPILOT_TOOLS.find((candidate) => candidate.name === call.name);
	if (!tool) {
		return `unknown tool "${call.name}" - available tools: ${COPILOT_TOOLS.map((t) => t.name).join(', ')}`;
	}
	return tool.execute(call.arguments, ctx);
}

function systemPrompt(projectId: string): string {
	return (
		`You are the Cloudflarebase copilot for project "${projectId}" - the operator's assistant inside the project dashboard. ` +
		'Use the provided tools to read live project data: auth_overview and auth_analytics for users, sessions, and activity; db_overview for collections; db_query for actual documents. ' +
		'Answer only from tool results - never invent metrics or documents, and say when there is not enough data. ' +
		'Be concise, and explain useful ratios or trends when the data supports them. ' +
		'Do not claim you can modify users, documents, or configuration. ' +
		`Today's date is ${new Date().toISOString().slice(0, 10)}.`
	);
}

export interface CopilotOutcome {
	answer: string;
	model: string;
}

/**
 * Runs the agentic loop: ask the model, execute any tool calls it makes
 * against the agents, feed the results back, and repeat until it answers in
 * text (or the tool budget runs out, when a final tool-less call forces one).
 * Throws on inference failure - the route maps that to the 502 contract.
 */
export async function runCopilot(options: {
	platform: App.Platform | undefined;
	origin: string;
	projectId: string;
	question: string;
	history: AgentChatMessage[];
}): Promise<CopilotOutcome> {
	const { platform, origin, projectId, question, history } = options;
	const env = platform?.env;
	if (!env?.AI) throw new Error('the AI binding is not available');
	const runner = env.AI as unknown as AiRunner;
	const model = env.CHAT_MODEL ?? DEFAULT_CHAT_MODEL;
	const ctx: ToolContext = { platform, origin, projectId };

	const messages: LoopMessage[] = [
		{ role: 'system', content: systemPrompt(projectId) },
		...history.slice(-10).map((message) => ({
			role: message.role === 'agent' ? ('assistant' as const) : ('user' as const),
			content: message.content
		})),
		{ role: 'user', content: question }
	];
	const tools = COPILOT_TOOLS.map(({ name, description, parameters }) => ({
		name,
		description,
		parameters
	}));

	for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
		const result = aiResultSchema.parse(
			await runner.run(model, { messages, tools, max_tokens: 600, temperature: 0.2 })
		);
		const calls = normalizeToolCalls(result.tool_calls);
		if (calls.length === 0) {
			const answer = result.response?.trim();
			if (!answer) throw new Error('Workers AI returned an empty response');
			return { answer, model };
		}
		messages.push({
			role: 'assistant',
			content: result.response?.trim() || JSON.stringify({ tool_calls: calls })
		});
		for (const call of calls) {
			messages.push({ role: 'tool', name: call.name, content: await executeToolCall(call, ctx) });
		}
	}

	// Tool budget spent - one last tool-less call forces a text answer.
	const final = aiResultSchema.parse(
		await runner.run(model, { messages, max_tokens: 600, temperature: 0.2 })
	);
	const answer = final.response?.trim();
	if (!answer) throw new Error('Workers AI returned an empty response');
	return { answer, model };
}
