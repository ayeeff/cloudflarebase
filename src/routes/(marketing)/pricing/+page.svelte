<script lang="ts">
	import { resolve } from '$app/paths';
	import ModeToggle from '$lib/components/mode-toggle.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Slider } from '$lib/components/ui/slider';
	import {
		estimateCloudflare,
		estimateFirebase,
		formatCount,
		formatUsd,
		scaleIndex,
		MODEL,
		PRESETS,
		PRICING_AS_OF,
		PRICING_SOURCES,
		SCALES
	} from '$lib/pricing';

	/**
	 * The versus split: shared workload controls on top, then the same app
	 * priced twice - your Cloudflare bill beside Firebase's. The breakdown bar
	 * follows the dataviz method: 4 fixed-order brand hues (validated for CVD
	 * and contrast on both surfaces), 2px surface gaps between segments, values
	 * in text tokens on the itemized legend, never on the marks.
	 */

	let readsIdx = $state(scaleIndex(SCALES.reads, PRESETS[1].inputs.reads));
	let writesIdx = $state(scaleIndex(SCALES.writes, PRESETS[1].inputs.writes));
	let storageIdx = $state(scaleIndex(SCALES.storageGb, PRESETS[1].inputs.storageGb));
	let connectionsIdx = $state(scaleIndex(SCALES.connections, PRESETS[1].inputs.connections));

	const inputs = $derived({
		reads: SCALES.reads[readsIdx],
		writes: SCALES.writes[writesIdx],
		storageGb: SCALES.storageGb[storageIdx],
		connections: SCALES.connections[connectionsIdx]
	});

	const cf = $derived(estimateCloudflare(inputs));
	const fb = $derived(estimateFirebase(inputs));
	const multiplier = $derived(cf.totalUsd > 0 ? fb.totalUsd / cf.totalUsd : 0);

	const activePreset = $derived(
		PRESETS.find(
			(preset) =>
				scaleIndex(SCALES.reads, preset.inputs.reads) === readsIdx &&
				scaleIndex(SCALES.writes, preset.inputs.writes) === writesIdx &&
				scaleIndex(SCALES.storageGb, preset.inputs.storageGb) === storageIdx &&
				scaleIndex(SCALES.connections, preset.inputs.connections) === connectionsIdx
		)?.id ?? null
	);

	function applyPreset(id: string) {
		const preset = PRESETS.find((entry) => entry.id === id);
		if (!preset) return;
		readsIdx = scaleIndex(SCALES.reads, preset.inputs.reads);
		writesIdx = scaleIndex(SCALES.writes, preset.inputs.writes);
		storageIdx = scaleIndex(SCALES.storageGb, preset.inputs.storageGb);
		connectionsIdx = scaleIndex(SCALES.connections, preset.inputs.connections);
	}

	/** Segments worth drawing; sub-cent lines stay in the legend only. */
	const segments = $derived(cf.items.filter((item) => item.usd >= 0.01));

	const sliders = $derived([
		{
			id: 'reads',
			label: 'Reads / month',
			value: formatCount(inputs.reads),
			max: SCALES.reads.length - 1,
			get: () => readsIdx,
			set: (index: number) => (readsIdx = index)
		},
		{
			id: 'writes',
			label: 'Writes / month',
			value: formatCount(inputs.writes),
			max: SCALES.writes.length - 1,
			get: () => writesIdx,
			set: (index: number) => (writesIdx = index)
		},
		{
			id: 'storage',
			label: 'Stored data',
			value: `${inputs.storageGb} GB`,
			max: SCALES.storageGb.length - 1,
			get: () => storageIdx,
			set: (index: number) => (storageIdx = index)
		},
		{
			id: 'connections',
			label: 'Concurrent realtime',
			value: formatCount(inputs.connections),
			max: SCALES.connections.length - 1,
			get: () => connectionsIdx,
			set: (index: number) => (connectionsIdx = index)
		}
	]);
</script>

<svelte:head>
	<title>Pricing · Cloudflarebase</title>
	<meta
		name="description"
		content="Cloudflarebase is free and open source. Estimate what your workload costs on your own Cloudflare account - next to the same app on Firebase."
	/>
</svelte:head>

<div class="flex min-h-screen flex-col" data-testid="pricing-page">
	<header class="border-b border-border px-4 sm:px-8">
		<div class="mx-auto flex max-w-5xl items-center justify-between py-4">
			<a href={resolve('/')} aria-label="home" class="flex items-center gap-2 text-lg font-bold">
				<img src="/brand/mark.svg" alt="" class="h-5 w-5" />
				Cloudflarebase
			</a>
			<div class="flex items-center gap-3">
				<a href={resolve('/')} class="text-sm text-muted-foreground hover:text-foreground">
					&larr; Home
				</a>
				<ModeToggle variant="ghost" class="h-9 w-9" />
			</div>
		</div>
	</header>

	<main class="flex-1 px-4 py-12 sm:px-8 sm:py-16">
		<div class="mx-auto max-w-5xl space-y-8">
			<div class="max-w-3xl">
				<h1 class="text-3xl font-semibold tracking-tight sm:text-4xl">
					Our price: <span class="text-primary">$0</span>.
				</h1>
				<p class="mt-3 text-muted-foreground">
					Cloudflarebase is open source and runs on your own Cloudflare account - there is no
					middleman bill. This estimates what a workload costs on the
					<a
						class="underline underline-offset-2 hover:text-foreground"
						href="https://developers.cloudflare.com/workers/platform/pricing/">Workers Paid plan</a
					>, next to the same app on Firebase.
				</p>
			</div>

			<div class="flex flex-wrap items-center gap-2">
				{#each PRESETS as preset (preset.id)}
					<Button
						variant={activePreset === preset.id ? 'default' : 'outline'}
						size="sm"
						data-testid={`pricing-preset-${preset.id}`}
						data-active={activePreset === preset.id}
						title={preset.description}
						onclick={() => applyPreset(preset.id)}
					>
						{preset.label}
					</Button>
				{/each}
			</div>

			<Card.Root>
				<Card.Content class="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
					{#each sliders as slider (slider.id)}
						<div class="space-y-2">
							<div class="flex items-baseline justify-between">
								<span class="text-sm text-muted-foreground">{slider.label}</span>
								<span
									class="font-mono text-sm font-medium tabular-nums"
									data-testid={`pricing-value-${slider.id}`}>{slider.value}</span
								>
							</div>
							<Slider
								type="single"
								min={0}
								max={slider.max}
								step={1}
								value={slider.get()}
								onValueChange={(index: number) => slider.set(index)}
								aria-label={slider.label}
							/>
						</div>
					{/each}
				</Card.Content>
			</Card.Root>

			<div class="grid grid-cols-1 items-stretch gap-6 lg:grid-cols-2">
				<Card.Root class="border-primary/40" data-testid="pricing-cloudflare">
					<Card.Header>
						<Card.Description>Cloudflarebase on your Cloudflare account</Card.Description>
						<Card.Title class="text-4xl tabular-nums" data-testid="pricing-total-cf">
							{formatUsd(cf.totalUsd)}<span class="text-base font-normal text-muted-foreground">
								/month</span
							>
						</Card.Title>
					</Card.Header>
					<Card.Content class="space-y-4">
						<!-- The breakdown bar: fixed-order segments, 2px surface gaps,
						     4px rounded data ends. Identity via the legend swatches;
						     values live in text tokens, never on the marks. -->
						<div
							class="flex h-4 w-full gap-0.5 overflow-hidden rounded-[4px]"
							role="img"
							aria-label={`Cost breakdown: ${cf.items
								.map((item) => `${item.label} ${formatUsd(item.usd)}`)
								.join(', ')}`}
							data-testid="pricing-breakdown"
						>
							{#each segments as item (item.id)}
								<div
									class="cost-segment h-full"
									style={`width:${Math.max(3, (item.usd / cf.totalUsd) * 100)}%;--segment:var(--cost-${item.id})`}
									title={`${item.label}: ${formatUsd(item.usd)} - ${item.detail}`}
								></div>
							{/each}
						</div>
						<ul class="space-y-1.5">
							{#each cf.items as item (item.id)}
								<li class="flex items-center justify-between gap-3 text-sm" title={item.detail}>
									<span class="flex min-w-0 items-center gap-2">
										<span
											class="cost-segment h-2.5 w-2.5 shrink-0 rounded-[3px]"
											style={`--segment:var(--cost-${item.id})`}
										></span>
										<span class="truncate text-muted-foreground">{item.label}</span>
									</span>
									<span class="font-mono tabular-nums">{formatUsd(item.usd)}</span>
								</li>
							{/each}
						</ul>
						<p class="text-xs text-muted-foreground">
							Rows read are effectively free: 25 <em>billion</em> are included before the first $0.001/M.
							Realtime pushes bill as Durable Object requests at $0.15/M.
						</p>
					</Card.Content>
				</Card.Root>

				<Card.Root data-testid="pricing-firebase">
					<Card.Header>
						<Card.Description>The same app on Firebase (Firestore, nam5)</Card.Description>
						<Card.Title class="text-4xl tabular-nums" data-testid="pricing-total-fb">
							{formatUsd(fb.totalUsd)}<span class="text-base font-normal text-muted-foreground">
								/month</span
							>
						</Card.Title>
					</Card.Header>
					<Card.Content class="space-y-4">
						{#if multiplier >= 1.05}
							<p class="text-sm font-medium" data-testid="pricing-multiplier">
								{multiplier >= 10 ? multiplier.toFixed(0) : multiplier.toFixed(1)}&times; the
								Cloudflare bill
							</p>
						{/if}
						<ul class="space-y-1.5 text-sm">
							<li class="flex items-center justify-between gap-3">
								<span class="text-muted-foreground">
									Document reads
									{#if fb.listenerReads > 0}
										<span class="text-xs"
											>(incl. {formatCount(fb.listenerReads)} listener reads)</span
										>
									{/if}
								</span>
								<span class="font-mono tabular-nums">{formatUsd(fb.readsUsd)}</span>
							</li>
							<li class="flex items-center justify-between gap-3">
								<span class="text-muted-foreground">Document writes</span>
								<span class="font-mono tabular-nums">{formatUsd(fb.writesUsd)}</span>
							</li>
							<li class="flex items-center justify-between gap-3">
								<span class="text-muted-foreground">Storage</span>
								<span class="font-mono tabular-nums">{formatUsd(fb.storageUsd)}</span>
							</li>
						</ul>
						<p class="text-xs text-muted-foreground">
							The structural difference: Firestore bills <strong
								>every document a realtime listener receives as a read</strong
							> ($0.06 per 100k) - fan-out multiplies the bill by subscriber count. Free tier (50k reads
							/ 20k writes per day) is folded in.
						</p>
					</Card.Content>
				</Card.Root>
			</div>

			<details class="text-sm text-muted-foreground">
				<summary class="cursor-pointer font-medium text-foreground">
					Model assumptions and sources
				</summary>
				<div class="mt-3 space-y-2">
					<p>
						An estimate whose assumptions are hidden is an ad, not a tool. This one assumes: each
						API read or write is one Worker request plus one Durable Object request (~{MODEL.cpuMsPerOp}ms
						CPU, ~5ms DO time); a read touches ~{MODEL.rowsPerRead} SQLite rows and a write ~{MODEL.rowsPerWrite};
						each realtime connection receives ~{MODEL.messagesPerConnectionMonth / 30} pushed updates
						a day. Idle WebSockets hibernate and cost nothing while quiet. Egress, Workers AI (the copilot),
						and multi-region read replicas (coming with the replication phase) are not modeled yet.
					</p>
					<p>
						Rates as of {PRICING_AS_OF}, from
						{#each PRICING_SOURCES as source, index (source.url)}
							<a class="underline underline-offset-2 hover:text-foreground" href={source.url}
								>{source.label}</a
							>{index < PRICING_SOURCES.length - 1 ? ', ' : '.'}
						{/each}
						Both bills are estimates - measure before you commit either way.
					</p>
				</div>
			</details>
		</div>
	</main>

	<footer class="border-t border-border px-4 py-6 sm:px-8">
		<div
			class="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground/70"
		>
			<span>&copy; 2026 Cloudflarebase</span>
			<nav class="flex gap-4">
				<a href={resolve('/privacy')} class="hover:text-foreground">Privacy</a>
				<a href={resolve('/terms')} class="hover:text-foreground">Terms</a>
			</nav>
		</div>
	</footer>
</div>

<style>
	/* The 4-slot cost palette: brand hues re-stepped for categorical use and
	   VALIDATED (CVD + contrast, light and dark surfaces) with the dataviz
	   palette validator - do not eyeball-edit these. Fixed assignment order:
	   base, requests, rows, storage. */
	div[data-testid='pricing-page'] {
		--cost-base: #cd6500;
		--cost-requests: #0e49bc;
		--cost-rows: #a48526;
		--cost-storage: #9b2014;
	}
	:global(.dark) div[data-testid='pricing-page'] {
		--cost-base: #d6701a;
		--cost-requests: #3d84ea;
		--cost-rows: #a7882a;
		--cost-storage: #c34f4b;
	}
	.cost-segment {
		background: var(--segment);
	}
</style>
