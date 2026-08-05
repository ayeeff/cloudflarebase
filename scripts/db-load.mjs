#!/usr/bin/env node
/**
 * DB agent load harness: N concurrent live-query subscribers (hibernatable
 * WebSockets) plus mixed REST read/write traffic, with correctness checks
 * that stay on under load:
 *
 *  - read-your-writes: every verified write threads its `cfb-lsn` bookmark
 *    into the read that checks it (`cfb-min-lsn`), so replica routing can
 *    never fake a pass.
 *  - delta delivery: a canary subscriber cohort materializes its snapshot +
 *    deltas and the end state is diffed against a fresh /query - dropped,
 *    duplicated, or misordered frames fail the run.
 *  - hibernation: an optional idle phase (--idle) long enough for production
 *    DOs to hibernate with sockets parked, then one write - every canary must
 *    still receive the delta (RPC push wakes hibernated replicas).
 *  - sibling spawn: the report includes the replica map (region, sibling n,
 *    reported sockets) so socket pressure is visible end to end.
 *
 * One process comfortably drives a few thousand sockets; 200k CCU is a fleet
 * of processes/machines each running a --shard i/n slice against a deployed
 * target. Local workerd is for correctness at modest scale, not absolute
 * numbers.
 *
 * Usage:
 *   node scripts/db-load.mjs --target http://localhost:8789 [options]
 *
 * The target is the DB WORKER origin (dev :8789, e2e :8799) - its admin
 * surface is service-binding/direct only, so no console session is needed.
 * To aim at a web-worker origin instead, pass --cookie with an operator
 * session cookie for the admin calls.
 *
 * Options:
 *   --target <origin>    required; http(s) origin of the db worker
 *   --project <id>       project id (default load-<hex>; NEVER demo-*)
 *   --ccu <n>            subscriber sockets (default 500)
 *   --canaries <n>       fully verified subscribers (default min(50, ccu))
 *   --writers <n>        concurrent writer loops (default 8)
 *   --readers <n>        concurrent reader loops (default 8)
 *   --wps <n>            target writes/second across all writers (default 50)
 *   --duration <s>       traffic phase seconds (default 30)
 *   --idle <s>           hibernation idle phase seconds (default 0 = skip)
 *   --churn <n>          sockets re-connected per second during traffic
 *   --tables             also declare a typed table and drive rows + /sql
 *   --region <hint>      force replica region via ?cfb-region (env.test only)
 *   --shard <i/n>        run slice i of n (1-based), e.g. --shard 2/40
 *   --cookie <value>     Cookie header for admin calls (web-worker targets)
 *   --keep               skip teardown (leave the shards for inspection)
 *   --json <file>        also write the report as JSON
 */

import { writeFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
	const args = { flags: {}, bools: new Set() };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (!arg.startsWith('--')) continue;
		const key = arg.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith('--')) args.bools.add(key);
		else {
			args.flags[key] = next;
			i += 1;
		}
	}
	return args;
}

const { flags, bools } = parseArgs(process.argv.slice(2));
const TARGET = (flags.target ?? '').replace(/\/$/, '');
if (!/^https?:\/\//.test(TARGET)) {
	console.error('Usage: node scripts/db-load.mjs --target http://localhost:8789 [options]');
	process.exit(2);
}
if (typeof WebSocket !== 'function') {
	console.error('Node 21+ required (global WebSocket).');
	process.exit(2);
}

const [SHARD_I, SHARD_N] = (flags.shard ?? '1/1').split('/').map(Number);
const PROJECT = flags.project ?? `load-${Math.random().toString(16).slice(2, 10)}`;
if (/^demo-/.test(PROJECT)) {
	console.error('Refusing a demo-* project id: demo caps would throttle the run.');
	process.exit(2);
}
const CCU = Math.ceil((Number(flags.ccu ?? 500) || 500) / SHARD_N);
const CANARIES = Math.min(Number(flags.canaries ?? 50) || 50, CCU);
const WRITERS = Number(flags.writers ?? 8) || 8;
const READERS = Number(flags.readers ?? 8) || 8;
const WPS = Number(flags.wps ?? 50) || 50;
const DURATION_S = Number(flags.duration ?? 30) || 30;
const IDLE_S = Number(flags.idle ?? 0) || 0;
const CHURN_PER_S = Number(flags.churn ?? 0) || 0;
const WITH_TABLES = bools.has('tables');
const REGION = flags.region ?? null;
const COOKIE = flags.cookie ?? null;
const KEEP = bools.has('keep');
const RUN = `${Date.now().toString(36)}-s${SHARD_I}`;

const COLLECTION = 'load_docs';
const TABLE = 'load_rows';
const BASE = `${TARGET}/agents/db-agent/${PROJECT}`;
const WS_BASE = BASE.replace(/^http/, 'ws');

// ---------------------------------------------------------------------------
// Metrics

const latencies = new Map(); // op -> number[] (ms)
const errors = new Map(); // op -> count
const counts = new Map(); // op -> count
function record(op, ms, ok) {
	counts.set(op, (counts.get(op) ?? 0) + 1);
	if (!ok) {
		errors.set(op, (errors.get(op) ?? 0) + 1);
		return;
	}
	let list = latencies.get(op);
	if (!list) latencies.set(op, (list = []));
	list.push(ms);
}
function percentile(list, p) {
	if (!list.length) return null;
	const sorted = [...list].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function timed(op, fn) {
	const start = performance.now();
	try {
		const result = await fn();
		record(op, performance.now() - start, true);
		return result;
	} catch (error) {
		record(op, 0, false);
		if ((errors.get(op) ?? 0) <= 3) console.error(`  [${op}]`, error.message ?? error);
		return null;
	}
}

function adminHeaders() {
	const headers = { 'content-type': 'application/json' };
	if (COOKIE) headers.cookie = COOKIE;
	return headers;
}

async function api(op, method, path, body, headers = {}) {
	return timed(op, async () => {
		const response = await fetch(`${BASE}${path}`, {
			method,
			headers: { 'content-type': 'application/json', ...headers },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		if (!response.ok) {
			throw new Error(`${method} ${path} -> ${response.status} ${await response.text()}`);
		}
		return response;
	});
}

// ---------------------------------------------------------------------------
// Subscriber fleet

const regionSuffix = REGION ? `?cfb-region=${REGION}` : '';

class Subscriber {
	constructor(index, canary) {
		this.index = index;
		this.canary = canary;
		this.docs = new Map(); // canary state machine: id -> data
		this.frames = 0;
		this.duplicateAdds = 0;
		this.deltaLatencies = [];
		this.snapshotAt = null;
		this.socket = null;
	}

	url() {
		return `${WS_BASE}/collections/${COLLECTION}/subscribe${regionSuffix}`;
	}

	connect() {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(this.url());
			this.socket = socket;
			const started = performance.now();
			const timer = setTimeout(() => reject(new Error('subscribe timeout')), 30_000);
			socket.addEventListener('open', () => {
				socket.send(
					JSON.stringify({
						type: 'subscribe',
						id: `sub-${this.index}`,
						// Canaries watch the marker cohort with full verification;
						// the bulk fleet watches a disjoint predicate so bulk writes
						// do not fan every frame to every socket at high CCU.
						query: this.canary
							? { where: [{ field: 'cohort', op: '==', value: `canary-${RUN}` }] }
							: { where: [{ field: 'cohort', op: '==', value: `bulk-${RUN}-${this.index % 97}` }] }
					})
				);
			});
			socket.addEventListener('message', (event) => {
				let frame;
				try {
					frame = JSON.parse(String(event.data));
				} catch {
					return;
				}
				this.frames += 1;
				if (frame.type === 'snapshot') {
					clearTimeout(timer);
					this.snapshotAt = performance.now();
					if (this.canary) {
						this.docs = new Map((frame.docs ?? []).map((doc) => [doc.id, doc.data]));
					}
					record('subscribe', this.snapshotAt - started, true);
					resolve();
					return;
				}
				if (frame.type === 'change' && this.canary) {
					const doc = frame.doc;
					if (!doc) return;
					if (frame.kind === 'added') {
						if (this.docs.has(doc.id)) this.duplicateAdds += 1;
						this.docs.set(doc.id, doc.data);
						if (typeof doc.data.sentAt === 'number') {
							this.deltaLatencies.push(Date.now() - doc.data.sentAt);
						}
					} else if (frame.kind === 'modified') {
						this.docs.set(doc.id, doc.data);
					} else if (frame.kind === 'removed') {
						this.docs.delete(doc.id);
					}
				}
			});
			socket.addEventListener('error', () => {
				clearTimeout(timer);
				record('subscribe', 0, false);
				reject(new Error('socket error'));
			});
		});
	}

	close() {
		try {
			this.socket?.close();
		} catch {
			// already gone
		}
	}
}

// ---------------------------------------------------------------------------
// Traffic loops

let stopTraffic = false;
let bookmark = 0;

async function writerLoop(writerIndex) {
	const intervalMs = (1000 * WRITERS) / WPS;
	let seq = 0;
	while (!stopTraffic) {
		const id = `w${writerIndex}-${RUN}-${seq}`;
		const canaryWrite = seq % 10 === 0;
		const cohort = canaryWrite
			? `canary-${RUN}`
			: `bulk-${RUN}-${(seq * WRITERS + writerIndex) % 97}`;
		const created = await api('doc-create', 'POST', `/collections/${COLLECTION}/documents`, {
			id,
			data: { cohort, writer: writerIndex, seq, sentAt: Date.now() }
		});
		if (created) {
			const lsn = Number(created.headers.get('cfb-lsn'));
			if (lsn > bookmark) bookmark = lsn;
			// Read-your-writes through whatever replica answers: the bookmark
			// forces catch-up, so a stale replica can never fake this pass.
			await timed('doc-ryw', async () => {
				const response = await fetch(`${BASE}/collections/${COLLECTION}/documents/${id}`, {
					headers: lsn ? { 'cfb-min-lsn': String(lsn) } : {}
				});
				if (!response.ok) throw new Error(`ryw ${response.status}`);
				const body = await response.json();
				if (body.data.seq !== seq) throw new Error('ryw returned a different write');
				return response;
			});
			if (seq % 5 === 2) {
				await api('doc-patch', 'PATCH', `/collections/${COLLECTION}/documents/${id}`, {
					patched: true
				});
			}
			if (seq % 7 === 3) {
				await api('doc-delete', 'DELETE', `/collections/${COLLECTION}/documents/${id}`);
			}
		}
		if (WITH_TABLES && seq % 3 === 0) {
			await api('row-create', 'POST', `/tables/${TABLE}/rows`, {
				data: { title: id, rank: seq }
			});
		}
		seq += 1;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

async function readerLoop(readerIndex) {
	let turn = 0;
	while (!stopTraffic) {
		const which = turn % (WITH_TABLES ? 4 : 3);
		if (which === 0) {
			await api('query', 'POST', `/collections/${COLLECTION}/query`, {
				where: [{ field: 'writer', op: '==', value: readerIndex % WRITERS }],
				limit: 20
			});
		} else if (which === 1) {
			await api('aggregate', 'POST', `/collections/${COLLECTION}/aggregate`, {
				aggregates: { total: { op: 'count' } }
			});
		} else if (which === 2) {
			await timed('query-bookmarked', async () => {
				const response = await fetch(`${BASE}/collections/${COLLECTION}/query`, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						...(bookmark ? { 'cfb-min-lsn': String(bookmark) } : {})
					},
					body: JSON.stringify({ limit: 5 })
				});
				if (!response.ok) throw new Error(`query ${response.status}`);
				return response;
			});
		} else {
			// The raw /sql endpoint always demands a project JWT, so the typed
			// query endpoint is what an anonymous load driver can exercise.
			await api('table-query', 'POST', `/tables/${TABLE}/query`, {
				orderBy: [{ field: 'rank', direction: 'desc' }],
				limit: 5
			});
		}
		turn += 1;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}

// ---------------------------------------------------------------------------
// Phases

async function main() {
	console.log(
		`db-load: ${TARGET} project=${PROJECT} ccu=${CCU} (shard ${SHARD_I}/${SHARD_N}) ` +
			`canaries=${CANARIES} writers=${WRITERS}@${WPS}wps readers=${READERS} ` +
			`duration=${DURATION_S}s idle=${IDLE_S}s churn=${CHURN_PER_S}/s tables=${WITH_TABLES}`
	);

	// 1. Provision (idempotent upserts; replication stays default-auto).
	const provision = await fetch(`${BASE}/admin/collections/${COLLECTION}`, {
		method: 'PUT',
		headers: adminHeaders(),
		body: JSON.stringify({ readAccess: 'public', writeAccess: 'public' })
	});
	if (!provision.ok) {
		console.error(`provision failed: ${provision.status} ${await provision.text()}`);
		process.exit(1);
	}
	if (WITH_TABLES) {
		const declare = await fetch(`${BASE}/admin/tables/${TABLE}`, {
			method: 'PUT',
			headers: adminHeaders(),
			body: JSON.stringify({
				readAccess: 'public',
				writeAccess: 'public',
				columns: [
					{ name: 'title', type: 'text', nullable: false },
					{ name: 'rank', type: 'integer', default: 0, index: true }
				]
			})
		});
		if (!declare.ok) {
			console.error(`table declare failed: ${declare.status} ${await declare.text()}`);
			process.exit(1);
		}
	}

	// 2. Ramp the subscriber fleet in batches.
	const fleet = [];
	const BATCH = 200;
	for (let start = 0; start < CCU; start += BATCH) {
		const batch = [];
		for (let index = start; index < Math.min(start + BATCH, CCU); index += 1) {
			const subscriber = new Subscriber(index, index < CANARIES);
			fleet.push(subscriber);
			batch.push(subscriber.connect().catch(() => {}));
		}
		await Promise.all(batch);
		process.stdout.write(`\r  ramp: ${Math.min(start + BATCH, CCU)}/${CCU} sockets`);
	}
	console.log(
		`\n  fleet up: ${fleet.filter((s) => s.snapshotAt !== null).length}/${CCU} subscribed`
	);

	// 3. Traffic.
	const loops = [
		...Array.from({ length: WRITERS }, (_, index) => writerLoop(index)),
		...Array.from({ length: READERS }, (_, index) => readerLoop(index))
	];
	if (CHURN_PER_S > 0) {
		loops.push(
			(async () => {
				while (!stopTraffic) {
					for (let churned = 0; churned < CHURN_PER_S; churned += 1) {
						const pick = fleet[CANARIES + Math.floor(Math.random() * Math.max(1, CCU - CANARIES))];
						if (!pick) continue;
						pick.close();
						await pick.connect().catch(() => {});
					}
					await new Promise((resolve) => setTimeout(resolve, 1000));
				}
			})()
		);
	}
	await new Promise((resolve) => setTimeout(resolve, DURATION_S * 1000));
	stopTraffic = true;
	await Promise.all(loops);

	// 4. Optional hibernation phase: park every socket, then prove one write
	// still reaches every canary through the wake chain.
	let hibernation = null;
	if (IDLE_S > 0) {
		console.log(`  idle ${IDLE_S}s (sockets parked; production DOs hibernate now)...`);
		await new Promise((resolve) => setTimeout(resolve, IDLE_S * 1000));
		const before = fleet.slice(0, CANARIES).map((canary) => canary.docs.size);
		const wakeId = `wake-${RUN}`;
		const wakeStart = Date.now();
		await api('wake-write', 'POST', `/collections/${COLLECTION}/documents`, {
			id: wakeId,
			data: { cohort: `canary-${RUN}`, sentAt: wakeStart }
		});
		const deadline = Date.now() + 30_000;
		let delivered = 0;
		while (Date.now() < deadline) {
			delivered = fleet
				.slice(0, CANARIES)
				.filter((canary, index) => canary.docs.size > before[index]).length;
			if (delivered === CANARIES) break;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		hibernation = { delivered, expected: CANARIES, wakeMs: Date.now() - wakeStart };
	}

	// 5. Canary end-state check: materialized snapshot+deltas vs a fresh query.
	await new Promise((resolve) => setTimeout(resolve, 3000));
	let canaryMismatches = 0;
	const truth = await fetch(`${BASE}/collections/${COLLECTION}/query`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'cfb-min-lsn': String(bookmark || 0) },
		body: JSON.stringify({
			where: [{ field: 'cohort', op: '==', value: `canary-${RUN}` }],
			limit: 200
		})
	});
	const truthIds = new Set((await truth.json()).docs.map((doc) => doc.id));
	for (const canary of fleet.slice(0, CANARIES)) {
		if (canary.snapshotAt === null) continue;
		const mine = new Set(
			[...canary.docs.keys()].filter((id) => canary.docs.get(id)?.cohort === `canary-${RUN}`)
		);
		if (mine.size !== truthIds.size || [...truthIds].some((id) => !mine.has(id))) {
			canaryMismatches += 1;
		}
	}

	// 6. Replica / sibling map.
	let replicaMap = null;
	try {
		const status = await fetch(`${BASE}/admin/replication/${COLLECTION}`, {
			headers: adminHeaders()
		});
		if (status.ok) replicaMap = await status.json();
	} catch {
		// direct-only surface may be absent behind some targets
	}

	// 7. Teardown.
	for (const subscriber of fleet) subscriber.close();
	if (!KEEP) {
		await fetch(`${BASE}/admin/collections/${COLLECTION}`, {
			method: 'DELETE',
			headers: adminHeaders()
		}).catch(() => {});
		if (WITH_TABLES) {
			await fetch(`${BASE}/admin/tables/${TABLE}`, {
				method: 'DELETE',
				headers: adminHeaders()
			}).catch(() => {});
		}
	}

	// 8. Report.
	const deltaAll = fleet.slice(0, CANARIES).flatMap((canary) => canary.deltaLatencies);
	const duplicates = fleet.reduce((sum, subscriber) => sum + subscriber.duplicateAdds, 0);
	const report = {
		target: TARGET,
		project: PROJECT,
		shard: `${SHARD_I}/${SHARD_N}`,
		ccu: CCU,
		subscribed: fleet.filter((subscriber) => subscriber.snapshotAt !== null).length,
		ops: Object.fromEntries(
			[...counts.keys()].map((op) => [
				op,
				{
					count: counts.get(op) ?? 0,
					errors: errors.get(op) ?? 0,
					p50: percentile(latencies.get(op) ?? [], 50),
					p95: percentile(latencies.get(op) ?? [], 95),
					p99: percentile(latencies.get(op) ?? [], 99)
				}
			])
		),
		deltas: {
			delivered: deltaAll.length,
			p50: percentile(deltaAll, 50),
			p95: percentile(deltaAll, 95),
			p99: percentile(deltaAll, 99),
			duplicates,
			canaryMismatches
		},
		hibernation,
		replicaMap
	};
	console.log('\n=== db-load report ===');
	console.table(report.ops);
	console.log('deltas:', report.deltas);
	if (hibernation) console.log('hibernation:', hibernation);
	if (replicaMap?.replicas?.length) {
		console.log('replicas:');
		console.table(
			replicaMap.replicas.map((replica) => ({
				id: replica.id,
				sockets: replica.sockets,
				push: replica.push,
				lag: replica.lagLsn
			}))
		);
	}
	if (flags.json) writeFileSync(flags.json, JSON.stringify(report, null, 2));

	const failed =
		canaryMismatches > 0 ||
		duplicates > 0 ||
		(hibernation && hibernation.delivered < hibernation.expected) ||
		[...errors.values()].reduce((sum, value) => sum + value, 0) > 0;
	console.log(failed ? '\nRESULT: FAIL (see above)' : '\nRESULT: PASS');
	process.exit(failed ? 1 : 0);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
