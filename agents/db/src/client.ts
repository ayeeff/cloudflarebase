import {
	querySchema,
	serverFrameSchema,
	type DbDocument,
	type Query,
	type ServerFrame,
} from './schemas';
import { orderComparator } from './query';

/**
 * Thin isomorphic client for the db agent (browsers and Node >= 22, which
 * ships a native WebSocket). No Workers imports. It reuses the SAME zod
 * schemas the agent validates with - client and server cannot drift.
 *
 * `baseUrl` is either the direct agent base
 * (`https://worker.example.com/agents/db-agent/<projectId>`) or the console
 * proxy base (`https://console.example.com/api/projects/<projectId>/db`).
 * Subscriptions always use the direct `/agents/...` path - WebSockets bypass
 * the REST proxy exactly like the dashboard's own realtime - so a proxy base
 * is rewritten for the socket URL.
 */

export interface DbClientOptions {
	baseUrl: string;
	/** Called per request; return null for public collections. */
	getToken?: () => Promise<string | null> | string | null;
	/** Reconnect backoff cap in ms (default 15_000). */
	maxBackoffMs?: number;
}

export interface QueryResult {
	docs: DbDocument[];
	nextCursor?: string;
}

export interface DocChange {
	kind: 'added' | 'modified' | 'removed';
	doc: DbDocument;
}

export interface SubscribeHandlers {
	onSnapshot?: (docs: DbDocument[]) => void;
	onChange?: (change: DocChange, docs: DbDocument[]) => void;
	onError?: (code: string, message: string) => void;
}

export class DbError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = 'DbError';
	}
}

export function createDbClient(options: DbClientOptions) {
	const baseUrl = options.baseUrl.replace(/\/$/, '');

	return {
		collection(name: string) {
			return new CollectionHandle(baseUrl, name, options);
		},
	};
}

class CollectionHandle {
	private socket: WebSocket | null = null;
	private subscribers = new Map<
		string,
		{ query: Query; handlers: SubscribeHandlers; docs: DbDocument[] }
	>();
	private nextSubId = 1;
	private backoffMs = 500;
	private closedByUser = false;

	constructor(
		private readonly baseUrl: string,
		private readonly name: string,
		private readonly options: DbClientOptions,
	) {}

	private url(subPath: string): string {
		return `${this.baseUrl}/collections/${this.name}${subPath}`;
	}

	private async headers(): Promise<Record<string, string>> {
		const headers: Record<string, string> = { 'content-type': 'application/json' };
		const token = await this.options.getToken?.();
		if (token) headers.authorization = `Bearer ${token}`;
		return headers;
	}

	private async request<T>(method: string, subPath: string, body?: unknown): Promise<T> {
		const response = await fetch(this.url(subPath), {
			method,
			headers: await this.headers(),
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
		if (!response.ok) {
			throw new DbError(response.status, payload?.error ?? `request failed (${response.status})`);
		}
		return payload as T;
	}

	async create(data: Record<string, unknown>, options: { id?: string } = {}): Promise<DbDocument> {
		return this.request('POST', '/documents', { id: options.id, data });
	}

	async get(id: string): Promise<DbDocument> {
		return this.request('GET', `/documents/${encodeURIComponent(id)}`);
	}

	/** Full replace of `data`. */
	async update(id: string, data: Record<string, unknown>): Promise<DbDocument> {
		return this.request('PUT', `/documents/${encodeURIComponent(id)}`, data);
	}

	/** Shallow merge into `data`. */
	async patch(id: string, partial: Record<string, unknown>): Promise<DbDocument> {
		return this.request('PATCH', `/documents/${encodeURIComponent(id)}`, partial);
	}

	async delete(id: string): Promise<void> {
		await this.request('DELETE', `/documents/${encodeURIComponent(id)}`);
	}

	async query(query: Query = {}): Promise<QueryResult> {
		return this.request('POST', '/query', querySchema.parse(query));
	}

	/**
	 * Live query. Returns an unsubscribe function. One socket per collection
	 * handle; subscriptions are multiplexed by id. On reconnect every active
	 * subscription is re-sent and receives a fresh snapshot (the server keeps
	 * no resume state). Local doc order is maintained with the same
	 * comparator the server's ORDER BY compiles to.
	 */
	subscribe(query: Query, handlers: SubscribeHandlers): () => void {
		const parsed = querySchema.parse(query);
		const subId = `s${this.nextSubId++}`;
		this.subscribers.set(subId, { query: parsed, handlers, docs: [] });

		void this.ensureSocket().then((socket) => {
			if (socket && this.subscribers.has(subId)) void this.sendSubscribe(socket, subId);
		});

		return () => {
			this.subscribers.delete(subId);
			if (this.socket?.readyState === WebSocket.OPEN) {
				this.socket.send(JSON.stringify({ type: 'unsubscribe', id: subId }));
			}
			if (this.subscribers.size === 0) {
				this.closedByUser = true;
				this.socket?.close(1000, 'no subscribers');
				this.socket = null;
			}
		};
	}

	private wsUrl(): string {
		// A console-proxy base rewrites to the direct agent path for the socket.
		const direct = this.baseUrl.replace(/\/api\/projects\/([^/]+)\/db$/, '/agents/db-agent/$1');
		return `${direct.replace(/^http/, 'ws')}/collections/${this.name}/subscribe`;
	}

	private ensureSocket(): Promise<WebSocket | null> {
		if (this.socket && this.socket.readyState <= WebSocket.OPEN) {
			const socket = this.socket;
			if (socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);
			return new Promise((resolve) => {
				socket.addEventListener('open', () => resolve(socket), { once: true });
				socket.addEventListener('close', () => resolve(null), { once: true });
			});
		}

		this.closedByUser = false;
		const socket = new WebSocket(this.wsUrl());
		this.socket = socket;

		socket.addEventListener('message', (event) => {
			this.handleFrame(typeof event.data === 'string' ? event.data : '');
		});
		socket.addEventListener('close', () => {
			if (this.socket === socket) this.socket = null;
			this.scheduleReconnect();
		});

		return new Promise((resolve) => {
			socket.addEventListener(
				'open',
				() => {
					this.backoffMs = 500;
					resolve(socket);
				},
				{ once: true },
			);
			socket.addEventListener('error', () => resolve(null), { once: true });
		});
	}

	private scheduleReconnect(): void {
		if (this.closedByUser || this.subscribers.size === 0) return;
		const delay = this.backoffMs;
		this.backoffMs = Math.min(this.backoffMs * 2, this.options.maxBackoffMs ?? 15_000);
		setTimeout(() => {
			if (this.closedByUser || this.subscribers.size === 0) return;
			void this.ensureSocket().then((socket) => {
				if (!socket) return;
				for (const subId of this.subscribers.keys()) void this.sendSubscribe(socket, subId);
			});
		}, delay);
	}

	private async sendSubscribe(socket: WebSocket, subId: string): Promise<void> {
		const entry = this.subscribers.get(subId);
		if (!entry || socket.readyState !== WebSocket.OPEN) return;
		const token = await this.options.getToken?.();
		socket.send(
			JSON.stringify({
				type: 'subscribe',
				id: subId,
				query: entry.query,
				...(token ? { token } : {}),
			}),
		);
	}

	private handleFrame(raw: string): void {
		let frame: ServerFrame;
		try {
			frame = serverFrameSchema.parse(JSON.parse(raw));
		} catch {
			return;
		}

		if (frame.type === 'error') {
			const entry = frame.id ? this.subscribers.get(frame.id) : undefined;
			entry?.handlers.onError?.(frame.code, frame.message);
			return;
		}
		if (frame.type === 'unsubscribed') return;

		const entry = this.subscribers.get(frame.id);
		if (!entry) return;
		const compare = orderComparator(entry.query);

		if (frame.type === 'snapshot') {
			entry.docs = [...frame.docs].sort(compare);
			entry.handlers.onSnapshot?.(entry.docs);
			return;
		}

		if (frame.kind === 'removed') {
			entry.docs = entry.docs.filter((doc) => doc.id !== frame.doc.id);
		} else {
			entry.docs = [...entry.docs.filter((doc) => doc.id !== frame.doc.id), frame.doc].sort(
				compare,
			);
			if (entry.query.limit !== undefined) {
				entry.docs = entry.docs.slice(0, entry.query.limit);
			}
		}
		entry.handlers.onChange?.({ kind: frame.kind, doc: frame.doc }, entry.docs);
	}
}
