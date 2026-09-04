<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { RefreshCw, Clock, Map, CheckCircle2, XCircle, FlaskConical, Database } from '@lucide/svelte';

	let { data, form } = $props();

	const geoBase = 'https://geo-astro-site.foodstarmelbourne.workers.dev';

	let running = $state(false);

	// The freshest status: the action result after a run, otherwise the load data.
	let status = $derived(form?.started?.progress ? { ...data.status, progress: form.started.progress } : data.status);
	let lastRun = $derived(status?.status?.lastRunAt ? new Date(status.status.lastRunAt) : null);
	let inProgress = $derived(!!status?.progress && status.progress.phase !== 'done');

	let ago = $state('');
	$effect(() => {
		if (!lastRun) {
			ago = '';
			return;
		}
		function tick() {
			const s = Math.max(0, Math.floor((Date.now() - lastRun!.getTime()) / 1000));
			ago =
				s < 90
					? `${s}s ago`
					: s < 3600
						? `${Math.floor(s / 60)}m ago`
						: s < 86400
							? `${Math.floor(s / 3600)}h ago`
							: `${Math.floor(s / 86400)}d ago`;
		}
		tick();
		const id = setInterval(tick, 15000);
		return () => clearInterval(id);
	});

	// Auto-refresh while a run is in flight so the progress bar advances live
	// (same pattern as the Search Index tab).
	$effect(() => {
		if (!inProgress) return;
		const id = setInterval(() => invalidateAll(), 8000);
		return () => clearInterval(id);
	});

	const families = $derived(Object.entries(status?.status?.families ?? {}));
	const progressPct = $derived.by(() => {
		const p = status?.progress;
		if (!p) return 0;
		if (p.phase === 'images') {
			const total = p.pages?.length ?? 0;
			const done = p.pageIndex ?? 0;
			const cityShare = ((p.cities?.length ?? 1) * 2) / ((p.cities?.length ?? 1) * 2 + (total || 1));
			return Math.min(100, Math.round(((cityShare + ((done / (total || 1)) * (1 - cityShare)) * 100) * 0.9 * 10) / 10 + 5));
		}
		const total = p.cities?.length ?? 0;
		return total ? Math.round(((p.cityIndex ?? 0) / total) * 70 * 10) / 10 : 0;
	});

	const FAMILY_LABELS: Record<string, string> = {
		city: 'City landmarks',
		metro: 'Metro & train',
		worship: 'Worship',
		schools: 'Schools',
		universities: 'Universities',
		suburbs: 'Expensive suburbs'
	};
</script>

<svelte:head>
	<title>Atlas Update · Geo Admin · Cloudflarebase</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-3xl space-y-6 px-3 py-5 sm:px-6 sm:py-8">
	<div>
		<h1 class="text-2xl font-bold tracking-tight">Atlas Update</h1>
		<p class="mt-1 text-sm text-muted-foreground">
			Monthly POI refresh for the <a href="{geoBase}/atlas" target="_blank" rel="noopener" class="text-blue-500 hover:underline">/atlas</a> pages —
			landmarks, worship, schools, universities, metro and suburbs. New and renamed places flow in from
			<a href="https://www.openstreetmap.org" target="_blank" rel="noopener" class="text-blue-500 hover:underline">OpenStreetMap</a>
			(Overpass) with
			<a href="https://overturemaps.org" target="_blank" rel="noopener" class="text-blue-500 hover:underline">Overture Maps</a>
			filling the gaps Overpass misses; dead Wikimedia images are pruned. Merged data is written to R2 and spliced into
			the served pages at request time — no rebuild.
		</p>
	</div>

	{#if inProgress}
		<section class="rounded-lg border bg-card p-5" data-testid="atlas-progress">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<div class="flex items-center gap-2 text-sm font-medium">
					<RefreshCw class="size-4 animate-spin text-muted-foreground" />
					Run in progress
					<span class="font-mono text-xs text-muted-foreground">{status.progress!.runId}{status.progress!.dry ? ' (dry)' : ''}</span>
				</div>
				<Badge variant="outline" class="text-xs capitalize">{status.progress!.phase}</Badge>
			</div>
			<div class="mt-3 h-2 overflow-hidden rounded-full bg-muted">
				<div class="h-full rounded-full bg-primary transition-all" style="width: {progressPct}%"></div>
			</div>
			<p class="mt-2 text-xs text-muted-foreground" data-testid="atlas-progress-detail">
				{#if status.progress!.phase === 'refresh'}
					{status.progress!.cityIndex ?? 0}/{status.progress!.cities?.length ?? 0} cities ·
					{status.progress!.totals?.added ?? 0} added · {status.progress!.totals?.coordUpdates ?? 0} coords fixed
				{:else}
					{status.progress!.pageIndex ?? 0}/{status.progress!.pages?.length ?? 0} pages image-checked ·
					{status.progress!.totals?.imagesDead ?? 0} dead images
				{/if}
			</p>
		</section>
	{/if}

	<section class="rounded-lg border bg-card p-5" data-testid="atlas-status">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div class="flex items-center gap-2 text-sm font-medium">
				<Clock class="size-4 text-muted-foreground" />
				Last run
			</div>
			{#if status?.status?.ok === false || (status?.status?.error && !status?.status?.ok)}
				<Badge variant="destructive" class="gap-1 text-xs" data-testid="atlas-error-badge">
					<XCircle class="size-3" /> failed
				</Badge>
			{:else if lastRun}
				<Badge variant="outline" class="gap-1 border-green-600/40 text-xs text-green-600" data-testid="atlas-ok-badge">
					<CheckCircle2 class="size-3" /> ok{status.status?.dry ? ' (dry)' : ''}
				</Badge>
			{/if}
		</div>

		{#if lastRun}
			<dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
				<dt class="text-muted-foreground">When</dt>
				<dd data-testid="atlas-last-run">{lastRun.toUTCString()} <span class="text-muted-foreground">({ago})</span></dd>
				<dt class="text-muted-foreground">Trigger</dt>
				<dd class="capitalize" data-testid="atlas-trigger">{status.status?.trigger ?? '—'}</dd>
				<dt class="text-muted-foreground">Duration</dt>
				<dd>{status.status?.durationMs != null ? `${(status.status.durationMs / 1000).toFixed(1)}s` : '—'}</dd>
				<dt class="text-muted-foreground">Cron</dt>
				<dd class="font-mono text-xs">{data.cron}</dd>
				<dt class="text-muted-foreground">Coverage</dt>
				<dd data-testid="atlas-coverage">
					{status.status?.totals?.pages ?? 0} pages · {status.status?.totals?.added ?? 0} POIs added ·
					{status.status?.totals?.coordUpdates ?? 0} coords fixed · {status.status?.totals?.imagesDead ?? 0} dead images pruned
					{#if status.status?.overtureCities}
						· Overture merged for {status.status.overtureCities} cities
					{/if}
				</dd>
			</dl>
		{:else}
			<p class="mt-3 text-sm text-muted-foreground" data-testid="atlas-never-run">
				{status?.neverRun
					? 'The monthly cron has not run yet — push a button to refresh now.'
					: `Could not read status: ${status?.error ?? 'unknown error'}`}
			</p>
		{/if}

		{#if status?.status?.error}
			<p class="mt-2 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">{status.status.error}</p>
		{/if}
	</section>

	{#if families.length}
		<section class="grid gap-3 sm:grid-cols-2">
			{#each families as [fam, s] (fam)}
				<div class="rounded-lg border bg-card p-4">
					<div class="flex items-center gap-2 text-sm font-medium">
						<Map class="size-4 text-muted-foreground" />
						{FAMILY_LABELS[fam] ?? fam}
					</div>
					<p class="mt-1 text-xs text-muted-foreground">
						{s.pages ?? 0} pages · {s.added ?? 0} added · {s.coordUpdates ?? 0} coords fixed
						{#if s.imagesDead}
							· {s.imagesDead} dead images
						{/if}
					</p>
				</div>
			{/each}
		</section>
	{/if}

	<section class="rounded-lg border bg-card p-5">
		<div class="flex items-center gap-2 text-sm font-medium">
			<Database class="size-4 text-muted-foreground" />
			Sources
		</div>
		<dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
			<dt class="text-muted-foreground">Registry</dt>
			<dd>
				{#if status?.registry}
					{status.registry.count} atlas pages · {status.registry.cities} cities
					{#if status.registry.generatedAt}
						<span class="text-muted-foreground">(built {new Date(status.registry.generatedAt).toISOString().slice(0, 10)})</span>
					{/if}
				{:else}
					<span class="text-destructive">unavailable — deploy the geo site so /atlas-data/_registry.json exists</span>
				{/if}
			</dd>
			<dt class="text-muted-foreground">Overture</dt>
			<dd data-testid="atlas-overture">
				{#if status?.overture?.stagedAt}
					extracts staged for {status.overture.cities ?? 0} cities
					<span class="text-muted-foreground">({new Date(status.overture.stagedAt).toISOString().slice(0, 10)})</span>
				{:else}
					not staged — run <code class="rounded bg-muted px-1 py-0.5 font-mono text-xs">npm run atlas-overture</code> in the geo repo
				{/if}
			</dd>
		</dl>
		<p class="mt-2 text-xs text-muted-foreground">
			Overture publishes places as parquet (no public REST API), so its extracts are staged to R2 locally via
			<code class="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">scripts/atlas-overture-extract.mjs</code>; the Worker merges them as the gap-filler for Overpass.
		</p>
	</section>

	<section class="flex flex-wrap gap-3">
		<form
			method="POST"
			action="?/run"
			use:enhance={() => {
				running = true;
				return async ({ update }) => {
					await update;
					running = false;
				};
			}}
		>
			<Button type="submit" disabled={running || inProgress} data-testid="atlas-run-button" class="gap-2">
				<RefreshCw class="size-4 {running ? 'animate-spin' : ''}" />
				{running ? 'Starting…' : 'Refresh atlas data now'}
			</Button>
		</form>
		<form
			method="POST"
			action="?/dry"
			use:enhance={() => {
				running = true;
				return async ({ update }) => {
					await update;
					running = false;
				};
			}}
		>
			<Button type="submit" disabled={running || inProgress} data-testid="atlas-dry-button" class="gap-2" variant="outline">
				<FlaskConical class="size-4" />
				Dry run (report only)
			</Button>
		</form>
		{#if form?.success === false && form?.error}
			<p class="w-full text-xs text-destructive" data-testid="atlas-run-error">{form.error}</p>
		{:else if form?.success && form?.started}
			<p class="w-full text-xs text-green-600" data-testid="atlas-run-ok">
				Started {form.started.runId}{form.started.dry ? ' (dry — no data written)' : ''} — watch the progress above (page auto-refreshes).
			</p>
		{/if}
	</section>
</div>
