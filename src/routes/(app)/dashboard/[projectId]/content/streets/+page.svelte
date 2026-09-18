<script lang="ts">
	import { page } from '$app/state';
	import * as Table from '$lib/components/ui/table';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import {
		MapPin,
		Database,
		HardDrive,
		Search,
		ExternalLink,
		Layers,
		CheckCircle2,
		Sparkles,
		Compass,
		ArrowUpRight,
		Terminal,
		Globe,
		FileText
	} from '@lucide/svelte';

	let { data } = $props();

	let searchQuery = $state(data.search?.q ?? '');
	let regions = $derived(data.regions);
	let summary = $derived(data.summary);
	let search = $derived(data.search);
	let siteBase = $derived(data.siteBase);

	function getFlag(code: string): string {
		if (code === 'US') return '🇺🇸';
		if (code === 'AU') return '🇦🇺';
		if (code === 'GB') return '🇬🇧';
		if (code === 'FR') return '🇫🇷';
		if (code === 'DE') return '🇩🇪';
		if (code === 'CA') return '🇨🇦';
		if (code.includes('IT')) return '🇮🇹 🇪🇸';
		if (code.includes('JP')) return '🇯🇵 🇸🇬';
		return '🌐';
	}
</script>

<svelte:head>
	<title>Streets & Address Index · Geo Dashboard · Cloudflarebase</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="space-y-6">
	<!-- Page Header -->
	<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
		<div>
			<div class="flex items-center gap-2">
				<h1 class="text-2xl font-bold tracking-tight">Street & Address Search Index</h1>
				<Badge variant="outline" class="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
					<CheckCircle2 class="mr-1 size-3.5" />
					Live on Edge
				</Badge>
			</div>
			<p class="text-sm text-muted-foreground">
				Global street and postcode centroid datalake in Cloudflare R2 (<code class="font-mono text-xs">geo-datalake</code>), streaming via DuckDB into universal MapShell deep-zoom navigation.
			</p>
		</div>

		<div class="flex items-center gap-2">
			<Button
				variant="outline"
				size="sm"
				href={`${siteBase}/search?q=Bourke+Street`}
				target="_blank"
				rel="noreferrer"
			>
				<ExternalLink class="mr-1.5 size-4" />
				Live Site Search
			</Button>
		</div>
	</div>

	<!-- Top Metrics Cards -->
	<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
		<Card.Root class="border-border/60 shadow-xs">
			<Card.Header class="flex flex-row items-center justify-between pb-2">
				<Card.Title class="text-xs font-medium text-muted-foreground">Total Unique Streets</Card.Title>
				<MapPin class="size-4 text-primary" />
			</Card.Header>
			<Card.Content>
				<div class="text-2xl font-bold tracking-tight">{summary.totalStreetsApprox}</div>
				<p class="text-xs text-muted-foreground mt-1">
					Preserves 100% of global names & postcodes
				</p>
			</Card.Content>
		</Card.Root>

		<Card.Root class="border-border/60 shadow-xs">
			<Card.Header class="flex flex-row items-center justify-between pb-2">
				<Card.Title class="text-xs font-medium text-muted-foreground">R2 Parquet Footprint</Card.Title>
				<Database class="size-4 text-emerald-600 dark:text-emerald-400" />
			</Card.Header>
			<Card.Content>
				<div class="text-2xl font-bold tracking-tight">~{summary.totalSizeGB} GB</div>
				<p class="text-xs text-muted-foreground mt-1">
					{summary.freeTierLimit}
				</p>
			</Card.Content>
		</Card.Root>

		<Card.Root class="border-border/60 shadow-xs">
			<Card.Header class="flex flex-row items-center justify-between pb-2">
				<Card.Title class="text-xs font-medium text-muted-foreground">Global Partitions</Card.Title>
				<Globe class="size-4 text-sky-600 dark:text-sky-400" />
			</Card.Header>
			<Card.Content>
				<div class="text-2xl font-bold tracking-tight">{summary.totalCountries}</div>
				<p class="text-xs text-muted-foreground mt-1">
					Hive partition: <code class="font-mono text-[10px]">country=&lt;ISO_2&gt;</code>
				</p>
			</Card.Content>
		</Card.Root>

		<Card.Root class="border-border/60 shadow-xs">
			<Card.Header class="flex flex-row items-center justify-between pb-2">
				<Card.Title class="text-xs font-medium text-muted-foreground">Target City Atlases</Card.Title>
				<Compass class="size-4 text-amber-600 dark:text-amber-400" />
			</Card.Header>
			<Card.Content>
				<div class="text-2xl font-bold tracking-tight">{summary.atlasCitiesCount} Cities</div>
				<p class="text-xs text-muted-foreground mt-1">
					Auto-flyTo + 3D centroid pin targeting
				</p>
			</Card.Content>
		</Card.Root>
	</div>

	<!-- Live Street Search Inspector -->
	<Card.Root class="border-border/60 shadow-xs">
		<Card.Header class="pb-3">
			<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
				<div>
					<Card.Title class="text-base font-semibold flex items-center gap-2">
						<Search class="size-4 text-primary" />
						Live Street Search Inspector
					</Card.Title>
					<Card.Description>
						Test live geocoding & City Atlas resolution via <code class="font-mono text-xs">/api/street-search.json</code>.
					</Card.Description>
				</div>
			</div>
		</Card.Header>
		<Card.Content class="space-y-4">
			<form method="GET" class="flex flex-col sm:flex-row gap-2">
				<div class="relative flex-1">
					<Search class="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
					<Input
						name="q"
						type="search"
						placeholder="Try 'Bourke Street', 'Swanston 3000', 'Broadway', or '5th Ave'…"
						bind:value={searchQuery}
						class="pl-9"
					/>
				</div>
				<Button type="submit">
					<Search class="mr-1.5 size-4" />
					Test Search
				</Button>
				{#if search.q}
					<Button variant="ghost" href="/dashboard/geo-site/content/streets">
						Clear
					</Button>
				{/if}
			</form>

			{#if search.error}
				<div class="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
					{search.error}
				</div>
			{:else if search.q}
				<div class="space-y-2 pt-1">
					<div class="flex items-center justify-between text-xs text-muted-foreground">
						<span>Found <strong>{search.count}</strong> match{search.count === 1 ? '' : 'es'} for query "{search.q}"</span>
						<span class="font-mono text-[11px]">Endpoint: /api/street-search.json?q={encodeURIComponent(search.q)}</span>
					</div>

					{#if search.results.length === 0}
						<div class="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
							No street matches found for "{search.q}". Try adding a postal code or another metro street name.
						</div>
					{:else}
						<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
							{#each search.results as res}
								<div class="rounded-lg border border-border/70 bg-card p-3.5 space-y-2.5 transition-all hover:border-primary/50">
									<div class="flex items-start justify-between gap-2">
										<div>
											<div class="font-semibold text-sm leading-tight flex items-center gap-1.5">
												<MapPin class="size-3.5 text-primary shrink-0" />
												{res.street}
											</div>
											<div class="text-xs text-muted-foreground mt-0.5">
												{res.city}{res.postcode ? ` ${res.postcode}` : ''}{res.region ? `, ${res.region}` : ''}
											</div>
										</div>
										<Badge variant="secondary" class="font-mono text-[10px] shrink-0">
											{res.country}
										</Badge>
									</div>

									<div class="flex items-center justify-between text-[11px] text-muted-foreground border-t pt-2">
										<span class="font-mono">{res.lat.toFixed(4)}, {res.lon.toFixed(4)}</span>
										<span>{res.pointCount} doors</span>
									</div>

									{#if res.atlasUrl}
										<Button
											size="sm"
											variant="secondary"
											class="w-full text-xs h-8 justify-between"
											href={`${siteBase}${res.atlasUrl}`}
											target="_blank"
											rel="noreferrer"
										>
											<span class="truncate">Open in {res.cityName ?? 'City'} Atlas</span>
											<ArrowUpRight class="size-3.5 shrink-0 ml-1" />
										</Button>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
		</Card.Content>
	</Card.Root>

	<!-- Regional Coverage & Ingestion Matrix -->
	<Card.Root class="border-border/60 shadow-xs">
		<Card.Header class="pb-3">
			<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
				<div>
					<Card.Title class="text-base font-semibold">Regional Index Coverage & Storage Footprint</Card.Title>
					<Card.Description>
						Canonical Overture Maps street aggregation breakdown by country partition in Cloudflare R2 datalake.
					</Card.Description>
				</div>
				<Badge variant="outline" class="font-mono text-xs w-fit">
					s3://geo-datalake/sources/addresses/
				</Badge>
			</div>
		</Card.Header>
		<Card.Content>
			<div class="rounded-lg border bg-card overflow-x-auto">
				<Table.Root>
					<Table.Header>
						<Table.Row class="bg-muted/30">
							<Table.Head class="font-semibold">Region / Country</Table.Head>
							<Table.Head class="font-semibold">Unique Streets</Table.Head>
							<Table.Head class="font-semibold">R2 Parquet Size</Table.Head>
							<Table.Head class="font-semibold hidden md:table-cell">Door Points Aggregated</Table.Head>
							<Table.Head class="font-semibold hidden lg:table-cell">Compression</Table.Head>
							<Table.Head class="font-semibold">Status</Table.Head>
							<Table.Head class="font-semibold hidden sm:table-cell">Primary Atlas Cities</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each regions as r}
							<Table.Row class="hover:bg-muted/20">
								<Table.Cell>
									<div class="font-medium text-sm flex items-center gap-2">
										<span class="text-base">{getFlag(r.countryCode)}</span>
										<span>{r.region}</span>
									</div>
									<div class="font-mono text-[11px] text-muted-foreground mt-0.5">
										{r.partitionKey}
									</div>
								</Table.Cell>
								<Table.Cell class="font-semibold font-mono text-sm">
									{r.uniqueStreets}
								</Table.Cell>
								<Table.Cell class="font-mono text-sm">
									<span class="font-semibold text-emerald-600 dark:text-emerald-400">{r.parquetSize}</span>
								</Table.Cell>
								<Table.Cell class="text-xs text-muted-foreground hidden md:table-cell">
									{r.rawDoorPoints}
								</Table.Cell>
								<Table.Cell class="text-xs font-mono text-muted-foreground hidden lg:table-cell">
									<Badge variant="secondary" class="font-normal text-[11px]">
										{r.compressionRatio} reduction
									</Badge>
								</Table.Cell>
								<Table.Cell>
									<Badge variant="outline" class="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs">
										<span class="size-1.5 rounded-full bg-emerald-500 mr-1.5"></span>
										Live
									</Badge>
								</Table.Cell>
								<Table.Cell class="text-xs text-muted-foreground max-w-xs hidden sm:table-cell">
									<div class="truncate">
										{r.primaryCities.join(', ')}
									</div>
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</div>
		</Card.Content>
	</Card.Root>

	<!-- Technical Specification & Operational Runbook -->
	<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
		<!-- Architecture Principles -->
		<Card.Root class="border-border/60 shadow-xs">
			<Card.Header class="pb-3">
				<Card.Title class="text-base font-semibold flex items-center gap-2">
					<Layers class="size-4 text-primary" />
					Mathematical Aggregation Model
				</Card.Title>
				<Card.Description>
					How 500M+ global door points are compacted into a high-speed search index.
				</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-3 text-xs leading-relaxed text-muted-foreground">
				<div class="rounded-md border bg-muted/20 p-3 space-y-1.5">
					<div class="font-semibold text-foreground text-xs">Tuple Transformation:</div>
					<code class="font-mono text-[11px] block text-foreground bg-muted/40 p-2 rounded">
						(country, postcode, street) ➔ (city, region, centroid_lat, centroid_lon, point_count)
					</code>
				</div>
				<ul class="list-disc pl-4 space-y-1.5">
					<li><strong>Zero Local Disk Usage:</strong> DuckDB streams directly from Overture Maps S3 partitions using HTTP range requests without downloading raw dumps.</li>
					<li><strong>WKB Bypass:</strong> Reads primitive <code class="font-mono text-[11px]">(bbox.xmin + bbox.xmax) / 2.0</code> floats, streaming ~20x faster with zero C++ spatial library overhead.</li>
					<li><strong>Multi-Tier Search:</strong> Top arterial streets hit an instant sub-10ms edge seed cache; broad searches query partitioned Parquet files in R2 with sub-second response times.</li>
					<li><strong>Universal MapShell Deep-Zoom:</strong> Automatically flies camera to <code class="font-mono text-[11px]">zoom: 16.5, pitch: 48</code> and anchors a pulsating target marker on the street.</li>
				</ul>
			</Card.Content>
		</Card.Root>

		<!-- Operational Commands -->
		<Card.Root class="border-border/60 shadow-xs">
			<Card.Header class="pb-3">
				<Card.Title class="text-base font-semibold flex items-center gap-2">
					<Terminal class="size-4 text-primary" />
					Ingestion & Sync Runbook
				</Card.Title>
				<Card.Description>
					PowerShell 7 (<code class="font-mono text-xs">pwsh</code>) command execution.
				</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-3 text-xs">
				<div class="space-y-1.5">
					<span class="font-semibold text-foreground">Ingest Priority Atlas Countries:</span>
					<div class="rounded bg-muted/40 p-2.5 font-mono text-[11px] text-foreground select-all">
						node scripts/sync-addresses-r2.mjs --countries=AU,US,GB,FR,DE,CA,JP,SG,IT,ES
					</div>
				</div>

				<div class="space-y-1.5">
					<span class="font-semibold text-foreground">Run Full Global Ingestion (All 190+ Countries):</span>
					<div class="rounded bg-muted/40 p-2.5 font-mono text-[11px] text-foreground select-all">
						node scripts/sync-addresses-r2.mjs --all
					</div>
				</div>

				<div class="space-y-1.5">
					<span class="font-semibold text-foreground">Query Direct from DuckDB over R2:</span>
					<div class="rounded bg-muted/40 p-2.5 font-mono text-[11px] text-foreground select-all">
						SELECT street, postcode, city, centroid_lat, centroid_lon<br/>
						FROM read_parquet('s3://geo-datalake/sources/addresses/street_postcode_city/country=AU/*.parquet')<br/>
						WHERE street ILIKE '%Swanston%' LIMIT 5;
					</div>
				</div>
			</Card.Content>
		</Card.Root>
	</div>
</div>
