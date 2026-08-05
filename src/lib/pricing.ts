/**
 * The /pricing calculator's rate card and cost model. Our price is $0 - the
 * page estimates what a WORKLOAD costs on the operator's own Cloudflare
 * account (Workers Paid), and what the same workload would cost on Firebase.
 *
 * Rates are STATIC CONSTANTS copied from the providers' published pricing and
 * reviewed on deploy - never a live API. When touching this file, re-check
 * every source below and move PRICING_AS_OF forward. The model constants
 * (rows per operation, messages per connection) are deliberately visible on
 * the page: an estimate whose assumptions are hidden is an ad, not a tool.
 */

export const PRICING_AS_OF = '2026-08-05';

export const PRICING_SOURCES = [
	{
		label: 'Cloudflare Workers pricing',
		url: 'https://developers.cloudflare.com/workers/platform/pricing/'
	},
	{
		label: 'Durable Objects pricing',
		url: 'https://developers.cloudflare.com/durable-objects/platform/pricing/'
	},
	{ label: 'Cloud Firestore pricing', url: 'https://firebase.google.com/docs/firestore/pricing' }
] as const;

/** Workers Paid plan + Durable Objects (SQLite storage backend). */
const CF = {
	baseUsd: 5,
	workersReqIncluded: 10_000_000,
	workersReqUsdPerM: 0.3,
	cpuMsIncluded: 30_000_000,
	cpuUsdPerMMs: 0.02,
	doReqIncluded: 1_000_000,
	doReqUsdPerM: 0.15,
	durationGbsIncluded: 400_000,
	durationUsdPerMGbs: 12.5,
	rowsReadIncluded: 25_000_000_000,
	rowsReadUsdPerM: 0.001,
	rowsWrittenIncluded: 50_000_000,
	rowsWrittenUsdPerM: 1,
	storageGbIncluded: 5,
	storageUsdPerGbMonth: 0.2
} as const;

/** Firestore, nam5 multi-region rates; free tier folded in per month. */
const FIREBASE = {
	readsUsdPer100k: 0.06,
	writesUsdPer100k: 0.18,
	storageUsdPerGbMonth: 0.18,
	freeReadsPerMonth: 50_000 * 30,
	freeWritesPerMonth: 20_000 * 30,
	freeStorageGb: 1
} as const;

/**
 * Model assumptions, stated on the page:
 * - One API read/write = 1 Workers request (the proxy) + 1 Durable Object
 *   request, ~3ms of Worker CPU and ~5ms of DO wall time at 128 MB.
 * - A read touches ~4 SQLite rows (document + config/subscription lookups);
 *   a write touches ~3.
 * - Each realtime connection receives ~50 pushed updates a day. On
 *   Cloudflarebase a pushed update is a WebSocket message (a DO request);
 *   on Firebase every document a listener receives bills as a READ.
 */
export const MODEL = {
	rowsPerRead: 4,
	rowsPerWrite: 3,
	messagesPerConnectionMonth: 1_500,
	cpuMsPerOp: 3,
	doGbsPerOp: 0.005 * 0.128
} as const;

export interface WorkloadInputs {
	/** Document/row reads per month. */
	reads: number;
	/** Document/row writes per month. */
	writes: number;
	/** Stored data in GB. */
	storageGb: number;
	/** Concurrent realtime connections. */
	connections: number;
}

export interface CostItem {
	id: 'base' | 'requests' | 'rows' | 'storage';
	label: string;
	usd: number;
	/** What this line is made of, for the tooltip/legend. */
	detail: string;
}

export interface CloudflareEstimate {
	totalUsd: number;
	items: CostItem[];
}

const overage = (used: number, included: number) => Math.max(0, used - included);

export function estimateCloudflare(inputs: WorkloadInputs): CloudflareEstimate {
	const ops = inputs.reads + inputs.writes;
	const messages = inputs.connections * MODEL.messagesPerConnectionMonth;

	const workersReqUsd = (overage(ops, CF.workersReqIncluded) / 1e6) * CF.workersReqUsdPerM;
	const cpuUsd = (overage(ops * MODEL.cpuMsPerOp, CF.cpuMsIncluded) / 1e6) * CF.cpuUsdPerMMs;
	const doReqUsd = (overage(ops + messages, CF.doReqIncluded) / 1e6) * CF.doReqUsdPerM;
	const durationUsd =
		(overage(ops * MODEL.doGbsPerOp, CF.durationGbsIncluded) / 1e6) * CF.durationUsdPerMGbs;

	const rowsReadUsd =
		(overage(inputs.reads * MODEL.rowsPerRead, CF.rowsReadIncluded) / 1e6) * CF.rowsReadUsdPerM;
	const rowsWrittenUsd =
		(overage(inputs.writes * MODEL.rowsPerWrite, CF.rowsWrittenIncluded) / 1e6) *
		CF.rowsWrittenUsdPerM;

	const storageUsd = overage(inputs.storageGb, CF.storageGbIncluded) * CF.storageUsdPerGbMonth;

	const items: CostItem[] = [
		{
			id: 'base',
			label: 'Workers Paid base',
			usd: CF.baseUsd,
			detail: 'The $5/month plan; most included allowances live here.'
		},
		{
			id: 'requests',
			label: 'Requests & compute',
			usd: workersReqUsd + cpuUsd + doReqUsd + durationUsd,
			detail: 'Worker + Durable Object requests (realtime pushes included) plus CPU and duration.'
		},
		{
			id: 'rows',
			label: 'Database rows',
			usd: rowsReadUsd + rowsWrittenUsd,
			detail: 'SQLite rows read ($0.001/M after 25 BILLION included) and written ($1/M after 50M).'
		},
		{
			id: 'storage',
			label: 'Storage',
			usd: storageUsd,
			detail: '$0.20/GB-month after the included 5 GB.'
		}
	];

	return {
		totalUsd: items.reduce((sum, item) => sum + item.usd, 0),
		items
	};
}

export interface FirebaseEstimate {
	totalUsd: number;
	readsUsd: number;
	writesUsd: number;
	storageUsd: number;
	/** The listener reads share of the reads bill - the structural difference. */
	listenerReads: number;
}

export function estimateFirebase(inputs: WorkloadInputs): FirebaseEstimate {
	// Firestore bills every document a realtime listener receives as a READ -
	// fan-out scales the bill by subscriber count.
	const listenerReads = inputs.connections * MODEL.messagesPerConnectionMonth;
	const reads = inputs.reads + listenerReads;

	const readsUsd =
		(overage(reads, FIREBASE.freeReadsPerMonth) / 100_000) * FIREBASE.readsUsdPer100k;
	const writesUsd =
		(overage(inputs.writes, FIREBASE.freeWritesPerMonth) / 100_000) * FIREBASE.writesUsdPer100k;
	const storageUsd =
		overage(inputs.storageGb, FIREBASE.freeStorageGb) * FIREBASE.storageUsdPerGbMonth;

	return {
		totalUsd: readsUsd + writesUsd + storageUsd,
		readsUsd,
		writesUsd,
		storageUsd,
		listenerReads
	};
}

// ---------------------------------------------------------------------------
// Presets and slider scales

export interface Preset {
	id: string;
	label: string;
	description: string;
	inputs: WorkloadInputs;
}

export const PRESETS: Preset[] = [
	{
		id: 'side',
		label: 'Side project',
		description: 'A few hundred users, evenings and weekends.',
		inputs: { reads: 200_000, writes: 50_000, storageGb: 1, connections: 25 }
	},
	{
		id: 'startup',
		label: 'Growing startup',
		description: 'Tens of thousands of users with live screens.',
		inputs: { reads: 20_000_000, writes: 3_000_000, storageGb: 20, connections: 2_000 }
	},
	{
		id: 'scale',
		label: '1M-user app',
		// Realtime-first on purpose: live queries REPLACE polling reads, so the
		// read count is modest while every open screen holds a subscription.
		description: 'Realtime-first: live queries replace polling.',
		inputs: { reads: 20_000_000, writes: 10_000_000, storageGb: 200, connections: 100_000 }
	}
];

/** Stepped slider scales - clean values over a log-ish range. */
export const SCALES = {
	reads: [
		50_000, 100_000, 200_000, 500_000, 1e6, 2e6, 5e6, 10e6, 20e6, 50e6, 100e6, 200e6, 300e6, 500e6,
		1e9
	],
	writes: [
		10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1e6, 3e6, 5e6, 10e6, 20e6, 40e6, 100e6, 200e6
	],
	storageGb: [1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000],
	connections: [10, 25, 100, 250, 500, 1_000, 2_000, 5_000, 10_000, 25_000, 50_000, 100_000]
} as const;

/** Nearest index into a scale for a preset value. */
export function scaleIndex(scale: readonly number[], value: number): number {
	let best = 0;
	for (let i = 1; i < scale.length; i += 1) {
		if (Math.abs(scale[i] - value) < Math.abs(scale[best] - value)) best = i;
	}
	return best;
}

export function formatCount(value: number): string {
	if (value >= 1e9) return `${(value / 1e9).toFixed(value % 1e9 ? 1 : 0)}B`;
	if (value >= 1e6) return `${(value / 1e6).toFixed(value % 1e6 ? 1 : 0)}M`;
	if (value >= 1e3) return `${(value / 1e3).toFixed(0)}k`;
	return String(value);
}

export function formatUsd(value: number): string {
	if (value >= 1_000) {
		return `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
	}
	return `$${value.toFixed(2)}`;
}
