/** Shared WebSocket test client for the db agent's live-query protocol. */

export const WEB_WS = 'ws://localhost:8797';
export const AGENT_WS = 'ws://localhost:8799';
const FRAME_TIMEOUT_MS = 5_000;

export interface Frame {
	type: string;
	id?: string;
	kind?: string;
	code?: string;
	docs?: { id: string; data: Record<string, unknown> }[];
	doc?: { id: string; data: Record<string, unknown> };
	[key: string]: unknown;
}

/**
 * Collects every server frame and hands them out once each, so a test can
 * await "the added frame" and "the removed frame" without caring which the
 * server sent first.
 */
export class LiveSocket {
	private readonly socket: WebSocket;
	private readonly frames: Frame[] = [];
	private readonly claimed = new Set<number>();
	private readonly opened: Promise<void>;

	private constructor(url: string) {
		this.socket = new WebSocket(url);
		this.opened = new Promise((resolve, reject) => {
			this.socket.addEventListener('open', () => resolve(), { once: true });
			this.socket.addEventListener(
				'error',
				() => reject(new Error(`WebSocket failed to open: ${url}`)),
				{ once: true }
			);
		});
		this.socket.addEventListener('message', (event) => {
			this.frames.push(JSON.parse(String(event.data)) as Frame);
		});
	}

	static async connect(url: string): Promise<LiveSocket> {
		const live = new LiveSocket(url);
		await live.opened;
		return live;
	}

	send(frame: unknown): void {
		this.socket.send(JSON.stringify(frame));
	}

	sendRaw(payload: string): void {
		this.socket.send(payload);
	}

	/** First unclaimed frame matching the predicate, or a descriptive timeout. */
	async next(predicate: (frame: Frame) => boolean, description: string): Promise<Frame> {
		const deadline = Date.now() + FRAME_TIMEOUT_MS;
		for (;;) {
			const index = this.frames.findIndex(
				(frame, position) => !this.claimed.has(position) && predicate(frame)
			);
			if (index !== -1) {
				this.claimed.add(index);
				return this.frames[index];
			}
			if (Date.now() > deadline) {
				throw new Error(
					`timed out waiting for ${description}; frames so far: ${JSON.stringify(this.frames)}`
				);
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}

	close(): void {
		try {
			this.socket.close();
		} catch {
			// already closed - nothing to release
		}
	}
}
