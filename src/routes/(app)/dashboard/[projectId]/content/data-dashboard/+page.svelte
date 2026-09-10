<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import { Badge } from '$lib/components/ui/badge';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import {
		Database,
		Layers,
		Search,
		ExternalLink,
		FileSpreadsheet,
		HardDrive,
		Terminal,
		Check,
		Copy,
		Sparkles
	} from '@lucide/svelte';

	let { data } = $props();

	const base = data.base ?? 'https://geo-astro-site.foodstarmelbourne.workers.dev';
	const summary = data.summary;
	const datasets = data.datasets ?? [];
	const loadError = data.error;
	const currentEnv = data.env ?? 'production';

	// Filters
	let q = $state('');
	let selectedBucket = $state('all');
	let selectedCategory = $state('all');
	let selectedRouteFilter = $state('all');

	// SQL copy state
	let copiedSql = $state<string | null>(null);
	function copyQuery(sql: string) {
		navigator.clipboard.writeText(sql);
		copiedSql = sql;
		setTimeout(() => {
			if (copiedSql === sql) copiedSql = null;
		}, 2000);
	}

	const categories = $derived.by(() => {
		const set = new Set<string>();
		for (const d of datasets) {
			if (d.category) set.add(d.category);
		}
		return Array.from(set).sort();
	});

	const filteredDatasets = $derived.by(() => {
		const query = q.trim().toLowerCase();
		return datasets.filter((d) => {
			if (selectedBucket !== 'all' && d.storageBucket !== selectedBucket) return false;
			if (selectedCategory !== 'all' && d.category !== selectedCategory) return false;
			if (selectedRouteFilter !== 'all') {
				const hasRoute = d.referencedRoutes.some((r) => r.category === selectedRouteFilter);
				if (!hasRoute) return false;
			}
			if (query) {
				const haystack = `${d.name} ${d.source} ${d.category} ${d.storagePrefix} ${d.description}`.toLowerCase();
				if (!haystack.includes(query)) return false;
			}
			return true;
		});
	});
</script>

<div class="flex flex-col gap-6 p-6" data-testid="data-dashboard">
	<!-- Header -->
	<div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
		<div>
			<div class="flex items-center gap-2">
				<Database class="size-6 text-primary" />
				<h1 class="text-2xl font-bold tracking-tight">R2 Data Catalog & Feeds</h1>
			</div>
			<p class="text-sm text-muted-foreground mt-1">
				Raw tabular datasets in <code class="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">geo-datalake</code> and PMTiles layer feeds in <code class="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">globe</code>, mapped to referencing routes across <code class="font-mono text-xs text-primary">/maps/</code>, <code class="font-mono text-xs text-primary">/atlas/</code>, <code class="font-mono text-xs text-primary">/portal/</code>, and <code class="font-mono text-xs text-primary">/guide/</code>.
			</p>
		</div>
		<div class="flex items-center gap-3">
			<!-- Environment Toggle -->
			<div class="inline-flex rounded-lg border bg-muted/60 p-1 text-xs">
				<a
					href="?env=production"
					class={['rounded-md px-3 py-1 font-medium transition-all', currentEnv !== 'preview' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground']}
				>
					Production (live)
				</a>
				<a
					href="?env=preview"
					class={['rounded-md px-3 py-1 font-medium transition-all', currentEnv === 'preview' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground']}
				>
					Preview (CI)
				</a>
			</div>

			<a
				href="{base}/api/data-catalog.json"
				target="_blank"
				rel="noreferrer"
				class="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md border border-border bg-card hover:bg-accent text-foreground transition-colors"
			>
				<ExternalLink class="size-3.5" />
				Catalog JSON
			</a>
		</div>
	</div>

	{#if loadError}
		<div class="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
			{loadError}
		</div>
	{/if}

	<!-- Metric Cards -->
	{#if summary}
		<div class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
			<div class="rounded-lg border bg-card p-3 flex flex-col gap-1">
				<span class="text-xs text-muted-foreground font-medium flex items-center gap-1.5">
					<Database class="size-3.5 text-primary" /> Total Datasets
				</span>
				<span class="text-xl font-bold tracking-tight">{summary.totalDatasets}</span>
				<span class="text-[10px] text-muted-foreground">All indexed sources</span>
			</div>
			<div class="rounded-lg border bg-card p-3 flex flex-col gap-1">
				<span class="text-xs text-muted-foreground font-medium flex items-center gap-1.5">
					<HardDrive class="size-3.5 text-amber-400" /> Datalake Tables
				</span>
				<span class="text-xl font-bold tracking-tight text-amber-400">{summary.datalakeDatasets}</span>
				<span class="text-[10px] text-muted-foreground">s3://geo-datalake/</span>
			</div>
			<div class="rounded-lg border bg-card p-3 flex flex-col gap-1">
				<span class="text-xs text-muted-foreground font-medium flex items-center gap-1.5">
					<Layers class="size-3.5 text-sky-400" /> Globe Layer Feeds
				</span>
				<span class="text-xl font-bold tracking-tight text-sky-400">{summary.globeLayerDatasets}</span>
				<span class="text-[10px] text-muted-foreground">s3://globe/basemaps/</span>
			</div>
			<div class="rounded-lg border bg-card p-3 flex flex-col gap-1">
				<span class="text-xs text-muted-foreground font-medium">Atlas Cities</span>
				<span class="text-xl font-bold tracking-tight">{summary.activeRoutes.atlas}</span>
				<span class="text-[10px] text-muted-foreground">/atlas/* cities</span>
			</div>
			<div class="rounded-lg border bg-card p-3 flex flex-col gap-1">
				<span class="text-xs text-muted-foreground font-medium">Urban Guides</span>
				<span class="text-xl font-bold tracking-tight">{summary.activeRoutes.guide}</span>
				<span class="text-[10px] text-muted-foreground">/guide/* guides</span>
			</div>
			<div class="rounded-lg border bg-card p-3 flex flex-col gap-1">
				<span class="text-xs text-muted-foreground font-medium">Global Portals</span>
				<span class="text-xl font-bold tracking-tight">{summary.activeRoutes.portal}</span>
				<span class="text-[10px] text-muted-foreground">/portal/* global hubs</span>
			</div>
		</div>
	{/if}

	<!-- Filter Controls -->
	<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between bg-card p-3 rounded-lg border">
		<div class="relative flex-1 max-w-sm">
			<Search class="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
			<Input
				type="search"
				placeholder="Filter datasets by name, source, or prefix…"
				bind:value={q}
				class="pl-9 h-9"
			/>
		</div>
		<div class="flex flex-wrap items-center gap-2">
			<div class="flex items-center gap-1.5 text-xs text-muted-foreground">
				<span>Storage:</span>
				<NativeSelect bind:value={selectedBucket} class="h-8 text-xs py-1">
					<option value="all">All Buckets</option>
					<option value="geo-datalake">geo-datalake</option>
					<option value="globe">globe</option>
				</NativeSelect>
			</div>
			<div class="flex items-center gap-1.5 text-xs text-muted-foreground">
				<span>Category:</span>
				<NativeSelect bind:value={selectedCategory} class="h-8 text-xs py-1">
					<option value="all">All Categories</option>
					{#each categories as cat}
						<option value={cat}>{cat}</option>
					{/each}
				</NativeSelect>
			</div>
			<div class="flex items-center gap-1.5 text-xs text-muted-foreground">
				<span>Route:</span>
				<NativeSelect bind:value={selectedRouteFilter} class="h-8 text-xs py-1">
					<option value="all">All Routes</option>
					<option value="maps">Maps (/maps/*)</option>
					<option value="atlas">Atlas (/atlas/*)</option>
					<option value="portal">Portal (/portal/*)</option>
					<option value="guide">Guide (/guide/*)</option>
				</NativeSelect>
			</div>
		</div>
	</div>

	<!-- Dataset Catalog Cards -->
	<div class="grid grid-cols-1 gap-4">
		{#each filteredDatasets as ds (ds.id)}
			<div class="rounded-xl border bg-card p-5 shadow-sm transition-all hover:border-border/80 flex flex-col gap-4">
				<!-- Header row -->
				<div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
					<div>
						<div class="flex flex-wrap items-center gap-2">
							<h3 class="text-base font-semibold text-foreground tracking-tight">{ds.name}</h3>
							<Badge variant="outline" class="text-[10px] font-medium border-border">
								{ds.category}
							</Badge>
							<Badge
								class={ds.storageBucket === 'geo-datalake' ? 'bg-amber-500/10 text-amber-400 border-amber-500/30' : 'bg-sky-500/10 text-sky-400 border-sky-500/30'}
								variant="outline"
							>
								{ds.storageBucket}
							</Badge>
							<Badge variant="secondary" class="text-[10px]">
								{ds.format}
							</Badge>
						</div>
						<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground mt-1.5">
							<span>Source: <a href={ds.sourceUrl} target="_blank" rel="noreferrer" class="text-primary hover:underline">{ds.source}</a></span>
							<span>•</span>
							<span>License: <strong class="text-foreground/80 font-normal">{ds.license}</strong></span>
							<span>•</span>
							<span>Cadence: <strong class="text-foreground/80 font-normal">{ds.updateCadence}</strong></span>
						</div>
					</div>
					<div class="text-right sm:flex sm:flex-col sm:items-end">
						<span class="text-sm font-semibold text-foreground">{ds.approxSize}</span>
						<span class="text-[11px] text-muted-foreground font-mono">{ds.recordCount}</span>
					</div>
				</div>

				<!-- Description -->
				<p class="text-xs text-muted-foreground leading-relaxed">
					{ds.description}
				</p>

				<!-- Storage location row -->
				<div class="rounded-lg bg-muted/50 p-2.5 border border-border/50 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs font-mono">
					<div class="flex items-center gap-2 overflow-hidden text-ellipsis whitespace-nowrap">
						<HardDrive class="size-3.5 text-muted-foreground shrink-0" />
						<span class="text-foreground/70 select-all">s3://{ds.storageBucket}/{ds.storagePrefix}</span>
					</div>
					<span class="text-[11px] text-muted-foreground shrink-0">{ds.filesSummary}</span>
				</div>

				<!-- SQL Snippet (if available) -->
				{#if ds.querySnippet}
					<div class="rounded-lg bg-black/40 border border-border/40 p-2.5 flex flex-col gap-1.5">
						<div class="flex items-center justify-between text-[11px] text-muted-foreground">
							<span class="flex items-center gap-1.5 font-medium">
								<Terminal class="size-3 text-primary" /> DuckDB SQL Query
							</span>
							<button
								type="button"
								onclick={() => copyQuery(ds.querySnippet!)}
								class="inline-flex items-center gap-1 text-[10px] hover:text-foreground transition-colors"
							>
								{#if copiedSql === ds.querySnippet}
									<Check class="size-3 text-emerald-400" />
									<span class="text-emerald-400">Copied</span>
								{:else}
									<Copy class="size-3" />
									<span>Copy SQL</span>
								{/if}
							</button>
						</div>
						<pre class="font-mono text-[11px] text-muted-foreground overflow-x-auto whitespace-pre-wrap select-all py-1">{ds.querySnippet}</pre>
					</div>
				{/if}

				<!-- Referenced Routes Grid -->
				<div class="border-t border-border/50 pt-3 flex flex-col gap-2">
					<span class="text-xs font-medium text-foreground/80 flex items-center gap-1.5">
						<FileSpreadsheet class="size-3.5 text-primary" /> Referenced Routes & Pages:
					</span>
					<div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-2">
						{#each ds.referencedRoutes as ref}
							<div class="rounded-md border bg-card/60 p-2 flex flex-col gap-1">
								<div class="flex items-center justify-between">
									<span class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
										/{ref.category}/*
									</span>
									<Badge variant="secondary" class="text-[9px] px-1.5 py-0">
										{ref.count} {ref.count === 1 ? 'page' : 'pages'}
									</Badge>
								</div>
								<div class="flex flex-wrap gap-1 mt-1">
									{#each ref.sampleUrls as url}
										<a
											href="{base}{url.href}"
											target="_blank"
											rel="noreferrer"
											class="text-[10px] font-medium text-primary hover:underline bg-muted/60 px-1.5 py-0.5 rounded flex items-center gap-0.5"
										>
											{url.label}
											<ExternalLink class="size-2 text-muted-foreground" />
										</a>
									{/each}
								</div>
							</div>
						{/each}
					</div>
				</div>
			</div>
		{:else}
			<div class="text-center py-12 border rounded-xl bg-card">
				<p class="text-sm text-muted-foreground">No datasets match the current filters.</p>
			</div>
		{/each}
	</div>
</div>