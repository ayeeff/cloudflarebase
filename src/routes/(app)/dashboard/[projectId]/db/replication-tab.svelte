<script lang="ts">
	import type { DbCollectionSummary, DbReplicationStatus, DbTableSummary } from '$lib/agents';
	import { WORLD_OUTLINE_PATH } from '$lib/world-outline';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as Table from '$lib/components/ui/table';
	import { Activity, Database, Globe, RefreshCw } from '@lucide/svelte';
	import { onMount, untrack } from 'svelte';

	/**
	 * The Replication tab: a live globe of where this project's data is being
	 * served from. Read-only on purpose - replication is enabled or disabled
	 * per shard in the Access tab and the table designer; this view answers
	 * "where are my reads landing right now".
	 */

	let {
		projectId,
		collections,
		tables
	}: {
		projectId: string;
		collections: DbCollectionSummary[];
		tables: DbTableSummary[];
	} = $props();

	type Shard = { name: string; kind: 'collection' | 'table'; replication: 'off' | 'auto' };
	const shards: Shard[] = $derived([
		...collections.map((collection) => ({
			name: collection.name,
			kind: 'collection' as const,
			replication: collection.replication
		})),
		...tables.map((table) => ({
			name: table.name,
			kind: 'table' as const,
			replication: table.replication
		}))
	]);
	const replicated = $derived(shards.filter((shard) => shard.replication === 'auto'));
	const optedOut = $derived(shards.filter((shard) => shard.replication === 'off'));

	// Status is per shard (one DO each), so the tab fans out one request per
	// replicated shard, bounded so a large project cannot stampede the parent.
	let statuses = $state<Record<string, DbReplicationStatus>>({});
	let loaded = $state(false);
	let loading = $state(false);

	async function loadStatuses() {
		if (loading) return;
		loading = true;
		const names = untrack(() => replicated.map((shard) => shard.name));
		const results: Record<string, DbReplicationStatus> = {};
		try {
			const CHUNK = 8;
			for (let start = 0; start < names.length; start += CHUNK) {
				await Promise.all(
					names.slice(start, start + CHUNK).map(async (name) => {
						try {
							const response = await fetch(
								`/api/projects/${projectId}/db/admin/replication/${encodeURIComponent(name)}`
							);
							if (!response.ok) return;
							results[name] = (await response.json()) as DbReplicationStatus;
						} catch {
							// shard unreachable - it just drops out of this refresh
						}
					})
				);
			}
			statuses = results;
		} finally {
			loaded = true;
			loading = false;
		}
	}

	// Refetch when the shard list changes (state sync bumps it); poll slowly
	// for lag/last-seen freshness - replicas move without registry changes.
	const shardKey = $derived(
		replicated
			.map((shard) => shard.name)
			.sort()
			.join(',')
	);
	$effect(() => {
		void shardKey;
		untrack(() => void loadStatuses());
	});
	onMount(() => {
		const poll = setInterval(() => void loadStatuses(), 15_000);
		return () => clearInterval(poll);
	});

	let reduceMotion = $state(true);
	onMount(() => {
		reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	});

	// ------------------------------------------------------------------
	// Aggregation: one row per region across every replicated shard.

	type RegionRow = {
		region: string;
		replicas: number;
		maxLag: number;
		push: number;
		sockets: number;
		lastSeenAt: string | null;
	};
	const regionRows = $derived.by(() => {
		const byRegion: Record<string, RegionRow> = {};
		for (const status of Object.values(statuses)) {
			if (!status.enabled) continue;
			for (const replica of status.replicas) {
				const row = (byRegion[replica.region] ??= {
					region: replica.region,
					replicas: 0,
					maxLag: 0,
					push: 0,
					sockets: 0,
					lastSeenAt: null
				});
				row.replicas += 1;
				row.maxLag = Math.max(row.maxLag, replica.lagLsn);
				row.push += replica.push ? 1 : 0;
				row.sockets += replica.sockets ?? 0;
				if (!row.lastSeenAt || replica.lastSeenAt > row.lastSeenAt) {
					row.lastSeenAt = replica.lastSeenAt;
				}
			}
		}
		return Object.values(byRegion).sort(
			(a, b) => b.replicas - a.replicas || a.region.localeCompare(b.region)
		);
	});
	const liveRegions = $derived(new Set(regionRows.map((row) => row.region)));
	const totalReplicas = $derived(regionRows.reduce((sum, row) => sum + row.replicas, 0));
	const maxLag = $derived(regionRows.reduce((max, row) => Math.max(max, row.maxLag), 0));

	function relativeTime(iso: string | null): string {
		if (!iso) return '—';
		const ms = Date.now() - new Date(iso).getTime();
		if (ms < 5_000) return 'just now';
		if (ms < 60_000) return `${Math.round(ms / 1_000)}s ago`;
		if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
		if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
		return `${Math.round(ms / 86_400_000)}d ago`;
	}

	// ------------------------------------------------------------------
	// The map: vendored simplified continent silhouettes (equirectangular,
	// 75N-60S - src/lib/world-outline.ts, generated, never hand-edited) with
	// theme-token fills, animateMotion packets gated on prefers-reduced-motion.

	const MAP_W = 480;
	const MAP_H = 240;

	/** Approximate anchor per region hint (agents/db/src/region.ts). */
	const REGION_POINTS: Record<string, { x: number; y: number; label: string }> = {
		wnam: { x: 85, y: 60, label: 'West North America' },
		enam: { x: 140, y: 65, label: 'East North America' },
		sam: { x: 180, y: 172, label: 'South America' },
		weur: { x: 247, y: 55, label: 'Western Europe' },
		eeur: { x: 272, y: 48, label: 'Eastern Europe' },
		me: { x: 318, y: 92, label: 'Middle East' },
		apac: { x: 395, y: 98, label: 'Asia-Pacific' },
		'apac-ne': { x: 430, y: 75, label: 'Asia-Pacific NE' },
		'apac-se': { x: 383, y: 132, label: 'Asia-Pacific SE' },
		oc: { x: 445, y: 190, label: 'Oceania' },
		afr: { x: 280, y: 178, label: 'Africa' }
	};
	/** Fallback when the primary has not reported a location (local dev, or
	 * the trace probe failed): mid-North-America, the most common case. */
	const HUB = { x: 112, y: 78 };

	/** Country -> region hint, mirroring the agent's region.ts buckets, for
	 * placing the primary hub. US stays on the fallback point - a country
	 * alone cannot pick wnam vs enam, and mid-continent reads honestly. */
	const PRIMARY_COUNTRY_REGION: Record<string, string> = {
		CA: 'enam',
		MX: 'wnam',
		AR: 'sam',
		BR: 'sam',
		CL: 'sam',
		CO: 'sam',
		BE: 'weur',
		CH: 'weur',
		DE: 'weur',
		DK: 'weur',
		ES: 'weur',
		FR: 'weur',
		GB: 'weur',
		IE: 'weur',
		IT: 'weur',
		NL: 'weur',
		NO: 'weur',
		PT: 'weur',
		SE: 'weur',
		AT: 'eeur',
		CZ: 'eeur',
		FI: 'eeur',
		GR: 'eeur',
		PL: 'eeur',
		RO: 'eeur',
		HK: 'apac',
		IN: 'apac',
		SG: 'apac',
		TW: 'apac',
		JP: 'apac-ne',
		KR: 'apac-ne',
		ID: 'apac-se',
		MY: 'apac-se',
		PH: 'apac-se',
		TH: 'apac-se',
		VN: 'apac-se',
		AU: 'oc',
		NZ: 'oc',
		EG: 'afr',
		KE: 'afr',
		NG: 'afr',
		ZA: 'afr',
		AE: 'me',
		BH: 'me',
		IL: 'me',
		QA: 'me',
		SA: 'me',
		TR: 'me'
	};

	/** First reported primary location across the fanned-out statuses. */
	const primaryLocation = $derived.by(() => {
		for (const status of Object.values(statuses)) {
			if (status.primary && (status.primary.colo || status.primary.country)) {
				return status.primary;
			}
		}
		return null;
	});
	const hub = $derived.by(() => {
		const region = PRIMARY_COUNTRY_REGION[primaryLocation?.country ?? ''];
		const point = region ? REGION_POINTS[region] : undefined;
		// Nudged off the region marker so the two glyphs stay distinguishable.
		return point ? { x: point.x, y: point.y + 14 } : HUB;
	});

	function arcPath(region: string): string {
		const to = REGION_POINTS[region];
		if (!to) return '';
		const mx = (hub.x + to.x) / 2;
		const my = (hub.y + to.y) / 2 - Math.min(28, Math.hypot(to.x - hub.x, to.y - hub.y) * 0.18);
		return `M${hub.x},${hub.y} Q${mx.toFixed(1)},${my.toFixed(1)} ${to.x},${to.y}`;
	}
</script>

<div class="mt-4 space-y-5 sm:space-y-6">
	<Card.Root data-testid="db-replication-card">
		<Card.Header>
			<Card.Title>Replication</Card.Title>
			<Card.Description>
				Reads are served from a replica in the reader's region; writes always land on the primary
				and answer with a <span class="font-mono text-foreground">cfb-lsn</span> bookmark that guarantees
				read-your-writes. Replicas materialize in a region the first time it reads. Turn replication off
				per shard in the Access tab or the table designer.
			</Card.Description>
			<Card.Action>
				<Button
					size="sm"
					variant="outline"
					disabled={loading}
					onclick={() => void loadStatuses()}
					data-testid="db-replication-refresh"
				>
					<RefreshCw class={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} /> Refresh
				</Button>
			</Card.Action>
		</Card.Header>
		<Card.Content>
			<div class="overflow-hidden rounded-xl border bg-muted/20">
				<svg
					viewBox="0 0 {MAP_W} {MAP_H}"
					class="w-full"
					role="img"
					aria-label="World map of live replica regions"
					data-testid="db-replication-map"
				>
					<path
						d={WORLD_OUTLINE_PATH}
						class="fill-primary/10 stroke-primary/20"
						stroke-width="0.5"
						stroke-linejoin="round"
					/>

					<!-- Arcs primary -> live regions, packets riding them. -->
					{#each regionRows as row, index (row.region)}
						{#if REGION_POINTS[row.region]}
							<path
								d={arcPath(row.region)}
								class="fill-none stroke-primary"
								stroke-width="1"
								stroke-dasharray="3 3"
								opacity="0.35"
							/>
							{#if !reduceMotion}
								<circle r="2" class="fill-primary">
									<animateMotion
										dur="{(2.4 + (index % 3) * 0.5).toFixed(1)}s"
										begin="{(index * 0.7).toFixed(1)}s"
										repeatCount="indefinite"
										path={arcPath(row.region)}
									/>
								</circle>
							{/if}
						{/if}
					{/each}

					<!-- Region markers: lit when a replica lives there. -->
					{#each Object.entries(REGION_POINTS) as [region, point] (region)}
						{@const lit = liveRegions.has(region)}
						{#if lit}
							<circle cx={point.x} cy={point.y} r="8" class="fill-primary/15" />
							<circle cx={point.x} cy={point.y} r="3" class="fill-primary" />
							{#if !reduceMotion}
								<circle
									cx={point.x}
									cy={point.y}
									r="5"
									opacity="0"
									class="fill-none stroke-primary"
									stroke-width="1"
								>
									<animate attributeName="r" values="4;10" dur="2s" repeatCount="indefinite" />
									<animate
										attributeName="opacity"
										values="0.6;0"
										dur="2s"
										repeatCount="indefinite"
									/>
								</circle>
							{/if}
							<text
								x={point.x}
								y={point.y - 7}
								text-anchor="middle"
								class="fill-foreground font-mono"
								font-size="7"
							>
								{region}
							</text>
						{:else}
							<circle cx={point.x} cy={point.y} r="2" class="fill-muted-foreground/40">
								<title>{point.label} ({region}) - no replica yet</title>
							</circle>
							<text
								x={point.x}
								y={point.y - 6}
								text-anchor="middle"
								class="fill-muted-foreground/60 font-mono"
								font-size="6"
							>
								{region}
							</text>
						{/if}
					{/each}

					<!-- The primary hub, placed by the DO's own reported colo. -->
					<circle cx={hub.x} cy={hub.y} r="11" class="fill-primary/15" />
					<circle cx={hub.x} cy={hub.y} r="4.5" class="fill-primary" />
					<text
						x={hub.x}
						y={hub.y + 18}
						text-anchor="middle"
						class="fill-muted-foreground font-mono"
						font-size="7"
					>
						primary{primaryLocation?.colo ? ` · ${primaryLocation.colo}` : ''}
					</text>
				</svg>
			</div>
		</Card.Content>
	</Card.Root>

	<div class="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
		{#each [{ id: 'regions', label: 'Regions live', value: String(regionRows.length), icon: Globe }, { id: 'replicas', label: 'Replicas', value: String(totalReplicas), icon: Database }, { id: 'lag', label: 'Max lag', value: totalReplicas === 0 ? '—' : maxLag === 0 ? 'caught up' : `${maxLag} LSN`, icon: Activity }] as stat (stat.id)}
			<Card.Root class="py-4" data-testid={`db-replication-stat-${stat.id}`}>
				<Card.Content class="flex items-center justify-between gap-2 px-3 sm:px-5">
					<div>
						<p class="text-xs tracking-wide text-muted-foreground uppercase">{stat.label}</p>
						<p class="mt-1 text-2xl font-semibold tabular-nums" data-testid="stat-value">
							{stat.value}
						</p>
					</div>
					<div
						class="hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary min-[360px]:flex"
					>
						<stat.icon class="h-4.5 w-4.5" strokeWidth={1.8} />
					</div>
				</Card.Content>
			</Card.Root>
		{/each}
	</div>

	<Card.Root data-testid="db-replication-regions">
		<Card.Header>
			<Card.Title>Regions</Card.Title>
			<Card.Description>
				Replicas materialize per region per shard and spawn siblings under subscriber pressure. Lag
				is change-log entries behind the primary; "live push" replicas hold subscribers and receive
				every write the moment it lands.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if shards.length === 0}
				<p class="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
					No collections or tables yet - create one first.
				</p>
			{:else if replicated.length === 0}
				<p
					class="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground"
					data-testid="db-replication-all-off"
				>
					Every shard has replication turned off. Re-enable it per collection in the Access tab or
					per table in the table designer.
				</p>
			{:else if regionRows.length === 0}
				<p
					class="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground"
					data-testid="db-replication-empty"
				>
					{loaded
						? 'No region has read yet - the first read from a region materializes its replica.'
						: 'Loading replica status…'}
				</p>
			{:else}
				<div class="overflow-x-auto">
					<Table.Root class="min-w-[36rem]" data-testid="db-replication-table">
						<Table.Header>
							<Table.Row>
								<Table.Head>Region</Table.Head>
								<Table.Head class="text-right">Replicas</Table.Head>
								<Table.Head class="text-right">Sockets</Table.Head>
								<Table.Head class="text-right">Live push</Table.Head>
								<Table.Head class="text-right">Max lag</Table.Head>
								<Table.Head class="text-right">Last seen</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each regionRows as row (row.region)}
								<Table.Row data-testid={`db-replication-region-${row.region}`}>
									<Table.Cell>
										<div class="flex items-center gap-2">
											<span
												class={[
													'h-1.5 w-1.5 rounded-full',
													row.maxLag === 0 ? 'bg-emerald-500' : 'bg-amber-500'
												]}
											></span>
											<span class="font-mono text-sm font-medium">{row.region}</span>
											<span class="text-xs text-muted-foreground">
												{REGION_POINTS[row.region]?.label ?? ''}
											</span>
										</div>
									</Table.Cell>
									<Table.Cell class="text-right text-sm tabular-nums">{row.replicas}</Table.Cell>
									<Table.Cell class="text-right text-sm tabular-nums">{row.sockets}</Table.Cell>
									<Table.Cell class="text-right text-sm tabular-nums">{row.push}</Table.Cell>
									<Table.Cell class="text-right text-sm tabular-nums">
										{row.maxLag === 0 ? 'caught up' : `${row.maxLag} LSN`}
									</Table.Cell>
									<Table.Cell class="text-right text-sm tabular-nums">
										{relativeTime(row.lastSeenAt)}
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</div>
			{/if}
			{#if optedOut.length > 0}
				<p class="mt-3 text-xs text-muted-foreground" data-testid="db-replication-opted-out">
					{optedOut.length}
					{optedOut.length === 1 ? 'shard has' : 'shards have'} replication off:
					<span class="font-mono">{optedOut.map((shard) => shard.name).join(', ')}</span>
				</p>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
