<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Input } from '$lib/components/ui/input';
	import {
		RefreshCw,
		Clock,
		Play,
		Plus,
		Database,
		Crosshair,
		Trash2,
		LoaderCircle,
		CheckCircle2,
		XCircle,
		ExternalLink
	} from '@lucide/svelte';

	let { data, form } = $props();

	const geoBase = 'https://geo-astro-site.foodstarmelbourne.workers.dev';
	const layersBase = 'https://layers-worker.foodstarmelbourne.workers.dev';

	let startRunning = $state(false);
	let trackRunning = $state(false);
	let manifestRunning = $state(false);
	let statesRunning = $state(false);

	const LAYER_LABELS: Record<string, string> = {
		buildings: 'Buildings',
		terrain: 'Terrain',
		satellite: 'Satellite',
		population: 'Population',
		transit: 'Mobility',
		power: 'Power',
		bathymetry: 'Bathymetry'
	};
	const LAYER_SOURCES: Record<string, string> = {
		buildings: 'Protomaps',
		terrain: 'Mapterhorn',
		satellite: 'EOX s2cloudless',
		population: 'Kontur',
		transit: 'GTFS (Mobility DB)',
		power: 'OpenInfraMap',
		bathymetry: 'GEBCO 2024'
	};

	const gaps = $derived(data.gaps);
	const cities = $derived(Object.entries(data.cities?.cities ?? {}));
	const missingLayers = $derived(Object.entries(gaps?.perLayer ?? {}));
	const activeRuns = $derived(
		data.runs.filter((r) => r.status === 'queued' || r.status === 'running')
	);
	const unauthorized = $derived(
		!!gaps?.unauthorized || !!data.cities?.unauthorized || data.runs.some((r) => r.unauthorized)
	);

	// Auto-refresh while any tracked workflow is still in flight (same pattern
	// as the Atlas Update tab — load re-fetches the run statuses).
	$effect(() => {
		if (!activeRuns.length) return;
		const id = setInterval(() => invalidateAll(), 10000);
		return () => clearInterval(id);
	});

	function slugCity(slug: string): string {
		return data.cities?.cities?.[slug]?.city ?? slug;
	}

	function untrack(id: string) {
		const rest = data.runIds.filter((r) => r !== id);
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- hard-coded cross-project path, same as the sidebar
		void goto(`${page.url.pathname}${rest.length ? `?run=${rest.join(',')}` : ''}`, {
			replaceState: true
		});
	}

	function fmtBytes(n?: number): string {
		if (n == null) return '—';
		if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
		if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
		if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${n} B`;
	}

	function summaryEntries(
		output: { summary?: Record<string, unknown> } | null | undefined
	): [string, string][] {
		const s = output?.summary;
		if (!s || typeof s !== 'object') return [];
		return Object.entries(s)
			.filter(
				([, v]) => ['number', 'string', 'boolean'].includes(typeof v) && String(v).length <= 60
			)
			.slice(0, 8)
			.map(([k, v]) => [k, String(v)]);
	}

	const RUN_BADGES: Record<string, { label: string; cls: string }> = {
		queued: { label: 'queued', cls: 'border-amber-600/40 text-amber-600' },
		running: { label: 'running', cls: 'border-blue-600/40 text-blue-600' },
		complete: { label: 'complete', cls: 'border-green-600/40 text-green-600' },
		errored: { label: 'errored', cls: '' },
		terminated: { label: 'terminated', cls: '' }
	};
</script>

<svelte:head>
	<title>Layers Update · Geo Admin · Cloudflarebase</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-3xl space-y-6 px-3 py-5 sm:px-6 sm:py-8">
	<div>
		<h1 class="text-2xl font-bold tracking-tight">Layers Update</h1>
		<p class="mt-1 text-sm text-muted-foreground">
			City-atlas layer PMTiles built by the
			<a
				href="{layersBase}/dashboard"
				target="_blank"
				rel="noopener"
				class="text-blue-500 hover:underline">layers-worker</a
			>
			100% in Workers + R2 — buildings/terrain from
			<a
				href="https://build.protomaps.com"
				target="_blank"
				rel="noopener"
				class="text-blue-500 hover:underline">Protomaps</a
			>
			+ Mapterhorn, satellite from EOX, population from Kontur, mobility from GTFS, power from OpenInfraMap,
			bathymetry from GEBCO. Output lands in the same R2 bucket the site serves
			<code class="rounded bg-muted px-1 py-0.5 font-mono text-xs">/basemaps/*</code> from; every
			run ends with a manifest refresh. See also the
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- hard-coded cross-project path, same as the sidebar -->
			<a href="/dashboard/geo-site/content/pmtiles-dashboard" class="text-blue-500 hover:underline"
				>PMTiles dashboard</a
			>.
		</p>
	</div>

	{#if unauthorized}
		<section class="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
			<p class="font-medium text-destructive">Bearer token missing</p>
			<p class="mt-1 text-muted-foreground">
				The layers-worker gates everything except /dashboard + /gaps behind its LAYERS_TOKEN secret.
				Give this Worker the same value once and every button here lights up:
				<code class="rounded bg-muted px-1 py-0.5 font-mono text-xs"
					>npx wrangler secret put LAYERS_TOKEN</code
				>
				(then redeploy or restart).
			</p>
		</section>
	{/if}

	<section class="rounded-lg border bg-card p-5" data-testid="layers-gaps">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div class="flex items-center gap-2 text-sm font-medium">
				<Crosshair class="size-4 text-muted-foreground" />
				Coverage (live manifest gap matrix)
			</div>
			{#if gaps?.manifestGeneratedAt}
				<Badge variant="outline" class="gap-1 text-xs">
					<Database class="size-3" />
					{gaps.manifestFiles ?? 0} files · {new Date(gaps.manifestGeneratedAt)
						.toISOString()
						.slice(0, 16)
						.replace('T', ' ')} UTC
				</Badge>
			{/if}
		</div>
		{#if gaps?.ok}
			<dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
				<dt class="text-muted-foreground">Cities</dt>
				<dd data-testid="layers-gap-totals">
					{gaps.totals?.withBase ?? 0} with base basemap · {gaps.totals?.noBase ?? 0} of
					{gaps.totals?.candidates ?? 0} candidates missing base
				</dd>
				<dt class="text-muted-foreground">Missing layers</dt>
				<dd class="flex flex-wrap gap-1.5" data-testid="layers-gap-perlayer">
					{#if missingLayers.length}
						{#each missingLayers as [key, count] (key)}
							<Badge variant="outline" class="text-xs {count > 0 ? 'border-destructive/40' : ''}">
								{LAYER_LABELS[key] ?? key}: {count}
							</Badge>
						{/each}
					{:else}
						<span class="text-muted-foreground">—</span>
					{/if}
				</dd>
			</dl>
			{#if missingLayers.length}
				<div class="mt-3 grid gap-2 sm:grid-cols-2">
					{#each missingLayers as [key, count] (key)}
						{@const slugs = gaps?.union?.layers?.[key] ?? []}
						{#if count > 0}
							<details class="rounded border px-3 py-2">
								<summary class="cursor-pointer text-xs font-medium">
									{LAYER_LABELS[key] ?? key} — {count} cities missing
								</summary>
								<p class="mt-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
									{slugs
										.slice(0, 12)
										.map((s) => `${s} (${slugCity(s)})`)
										.join(' · ')}{slugs.length > 12 ? ` · …${slugs.length - 12} more` : ''}
								</p>
							</details>
						{/if}
					{/each}
				</div>
			{/if}
		{:else}
			<p class="mt-3 text-sm text-muted-foreground">
				Could not read the gap matrix: {gaps?.error ?? 'unknown error'}
			</p>
		{/if}
	</section>

	<section class="rounded-lg border bg-card p-5" data-testid="layers-runs">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div class="flex items-center gap-2 text-sm font-medium">
				<LoaderCircle
					class="size-4 text-muted-foreground {activeRuns.length ? 'animate-spin' : ''}"
				/>
				Workflow runs {activeRuns.length ? `(${activeRuns.length} in flight)` : ''}
			</div>
			{#if data.runs.length}
				<Button
					variant="ghost"
					size="sm"
					type="button"
					onclick={() => invalidateAll()}
					class="gap-1.5 text-xs"
				>
					<RefreshCw class="size-3.5" /> Re-check now
				</Button>
			{/if}
		</div>

		{#if data.runs.length}
			<div class="mt-3 space-y-2">
				{#each data.runs as run (run.id)}
					{@const badge = RUN_BADGES[run.status ?? ''] ?? {
						label: run.status ?? 'unknown',
						cls: ''
					}}
					<div class="rounded border px-3 py-2" data-testid="layers-run">
						<div class="flex flex-wrap items-center justify-between gap-2">
							<div class="flex items-center gap-2 text-sm">
								{#if run.status === 'complete'}
									<CheckCircle2 class="size-4 text-green-600" />
								{:else if run.status === 'errored' || run.ok === false}
									<XCircle class="size-4 text-destructive" />
								{:else}
									<LoaderCircle class="size-4 animate-spin text-blue-600" />
								{/if}
								<span class="font-mono text-xs">{run.id}</span>
								<Badge
									variant={run.status === 'errored' || run.ok === false ? 'destructive' : 'outline'}
									class="text-xs {badge.cls}"
								>
									{badge.label}
								</Badge>
							</div>
							<Button
								variant="ghost"
								size="sm"
								type="button"
								onclick={() => untrack(run.id)}
								class="h-7 gap-1 px-2 text-xs text-muted-foreground"
							>
								<Trash2 class="size-3" /> untrack
							</Button>
						</div>
						{#if summaryEntries(run.output).length}
							<p class="mt-1 font-mono text-[11px] text-muted-foreground">
								{summaryEntries(run.output)
									.map(([k, v]) => (k === 'bytes' ? `${k}=${fmtBytes(Number(v))}` : `${k}=${v}`))
									.join(' · ')}
							</p>
						{/if}
						{#if run.error}
							<p class="mt-1 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">
								{run.error}
							</p>
						{/if}
					</div>
				{/each}
			</div>
			<p class="mt-2 text-xs text-muted-foreground">In-flight runs auto-refresh every 10 s.</p>
		{:else}
			<p class="mt-3 text-sm text-muted-foreground">
				No runs tracked. Start one below (or track an instance id from a previous session) —
				instance ids keep working across page loads.
			</p>
		{/if}

		<form
			method="POST"
			action="?/track"
			use:enhance={() => {
				trackRunning = true;
				return async ({ update }) => {
					await update;
					trackRunning = false;
				};
			}}
			class="mt-3 flex gap-2"
		>
			<Input
				name="id"
				placeholder="track an existing instance id"
				class="h-8 w-64 font-mono text-xs"
			/>
			<Button
				type="submit"
				variant="outline"
				size="sm"
				disabled={trackRunning}
				data-testid="layers-track-button"
				class="gap-1.5"
			>
				<Plus class="size-3.5" /> Track
			</Button>
		</form>
		{#if form?.action === 'track' && form?.error}
			<p class="mt-1 text-xs text-destructive">{form.error}</p>
		{/if}
	</section>

	<section class="rounded-lg border bg-card p-5">
		<div class="flex items-center gap-2 text-sm font-medium">
			<Play class="size-4 text-muted-foreground" />
			Start a build
		</div>
		<form
			method="POST"
			action="?/start"
			use:enhance={() => {
				startRunning = true;
				return async ({ update }) => {
					await update;
					startRunning = false;
				};
			}}
			class="mt-3 grid gap-2 sm:grid-cols-2"
		>
			<label class="grid gap-1 text-xs text-muted-foreground">
				Layer
				<select
					name="layer"
					class="h-8 rounded-md border bg-transparent px-2 text-sm"
					data-testid="layers-layer-select"
				>
					{#each Object.keys(LAYER_LABELS) as l (l)}
						<option value={l}>{LAYER_LABELS[l]} — {LAYER_SOURCES[l]}</option>
					{/each}
				</select>
			</label>
			<label class="grid gap-1 text-xs text-muted-foreground">
				City slug
				<Input
					name="slug"
					list="layers-city-slugs"
					placeholder="paris"
					required
					class="h-8 font-mono text-xs"
				/>
				<datalist id="layers-city-slugs">
					{#each cities as [slug, c] (slug)}
						<option value={slug}>{c.city}{c.country ? `, ${c.country}` : ''}</option>
					{/each}
				</datalist>
			</label>
			<label class="grid gap-1 text-xs text-muted-foreground">
				City label <span class="normal-case">(optional — also the geocode query)</span>
				<Input name="city" placeholder="Paris, France" class="h-8 text-xs" />
			</label>
			<label class="grid gap-1 text-xs text-muted-foreground">
				Bbox <span class="normal-case">(optional — geocoded via Nominatim when empty)</span>
				<Input name="bbox" placeholder="2.25,48.8,2.42,48.91" class="h-8 font-mono text-xs" />
			</label>
			<label class="grid gap-1 text-xs text-muted-foreground">
				Max feeds <span class="normal-case">(mobility only)</span>
				<Input name="maxFeeds" type="number" min="1" max="6" placeholder="6" class="h-8 text-xs" />
			</label>
			<div class="flex items-end">
				<Button
					type="submit"
					disabled={startRunning}
					data-testid="layers-start-button"
					class="gap-2"
				>
					<RefreshCw class="size-4 {startRunning ? 'animate-spin' : ''}" />
					{startRunning ? 'Starting…' : 'Start workflow run'}
				</Button>
			</div>
		</form>
		{#if form?.action === 'start' && form?.error}
			<p class="mt-2 text-xs text-destructive" data-testid="layers-start-error">{form.error}</p>
		{/if}
	</section>

	<section class="rounded-lg border bg-card p-5">
		<div class="flex items-center gap-2 text-sm font-medium">
			<Database class="size-4 text-muted-foreground" />
			Maintenance
		</div>
		<div class="mt-3 flex flex-wrap gap-3">
			<form
				method="POST"
				action="?/manifest"
				use:enhance={() => {
					manifestRunning = true;
					return async ({ update }) => {
						await update;
						manifestRunning = false;
					};
				}}
			>
				<Button
					type="submit"
					variant="outline"
					disabled={manifestRunning}
					data-testid="layers-manifest-button"
					class="gap-2"
				>
					<RefreshCw class="size-4 {manifestRunning ? 'animate-spin' : ''}" />
					Refresh basemaps manifest
				</Button>
			</form>
			<form
				method="POST"
				action="?/states"
				use:enhance={() => {
					statesRunning = true;
					return async ({ update }) => {
						await update;
						statesRunning = false;
					};
				}}
			>
				<Button
					type="submit"
					variant="outline"
					disabled={statesRunning}
					data-testid="layers-states-button"
					class="gap-2"
				>
					<Clock class="size-4 {statesRunning ? 'animate-spin' : ''}" />
					Scan pipeline states
				</Button>
			</form>
		</div>
		{#if form?.action === 'manifest' && form?.manifest}
			<p class="mt-2 text-xs text-green-600" data-testid="layers-manifest-ok">
				Manifest refreshed — {form.manifest.count} files from {form.manifest.objects} objects in
				{((form.manifest.durationMs ?? 0) / 1000).toFixed(1)}s. The repo copy does not update itself
				— run
				<code class="rounded bg-muted px-1 py-0.5 font-mono text-[10px]"
					>node layer/pull-basemaps-manifest.mjs</code
				> in the geo repo.
			</p>
		{/if}
		{#if form?.action === 'states' && form?.states}
			<div class="mt-2 grid gap-2 sm:grid-cols-2" data-testid="layers-states-result">
				{#each Object.entries(form.states.byLayer ?? {}) as [layer, s] (layer)}
					<div class="rounded border px-3 py-2 text-xs">
						<span class="font-medium">{LAYER_LABELS[layer] ?? layer}</span>
						<span class="text-muted-foreground">
							— {s.done} done · {s.failed} failed · {s.total} tracked
						</span>
					</div>
				{/each}
			</div>
			{#if form.states.failed?.length}
				<details class="mt-2 rounded border px-3 py-2">
					<summary class="cursor-pointer text-xs font-medium text-destructive">
						{form.states.failed.length}+ failed states
					</summary>
					<p class="mt-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
						{form.states.failed
							.map((f) => `${f.layer}/${f.slug}${f.error ? `: ${f.error.slice(0, 60)}` : ''}`)
							.join(' · ')}
					</p>
				</details>
			{/if}
			<p class="mt-2 text-xs text-muted-foreground">
				Scanned {form.states.totalStates} state files. Per-city detail:
				<code class="rounded bg-muted px-1 py-0.5 font-mono text-[10px]"
					>/state?layer=&amp;slug=</code
				>
				on the
				<a href={layersBase} target="_blank" rel="noopener" class="text-blue-500 hover:underline"
					>worker</a
				>.
			</p>
		{/if}
		{#if form?.action === 'manifest' && form?.error}
			<p class="mt-2 text-xs text-destructive">{form.error}</p>
		{/if}
		{#if form?.action === 'states' && form?.error}
			<p class="mt-2 text-xs text-destructive">{form.error}</p>
		{/if}
	</section>

	<p class="text-xs text-muted-foreground">
		Every run's output pmtiles are served at
		<a
			href="{geoBase}/basemaps/paris.pmtiles"
			target="_blank"
			rel="noopener"
			class="text-blue-500 hover:underline">{geoBase}/basemaps/&lt;slug&gt;.pmtiles</a
		>
		— spot-check a fresh build with
		<code class="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">curl -I</code>.
		<a href="{layersBase}/gaps" target="_blank" rel="noopener" class="text-blue-500 hover:underline"
			>Raw gap matrix</a
		>
		<ExternalLink class="mb-0.5 inline size-3" />
	</p>
</div>
