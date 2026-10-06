<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { enhance } from '$app/forms';

	let { data } = $props();

	type City = {
		name: string;
		slug: string;
		prefix: string;
		continent: string;
		pop: number;
		storage19?: {
			slug: string;
			datalake: Record<string, boolean>;
			globe: Record<string, boolean>;
			missing: { datalake: string[]; globe: string[] };
			datalakePresentCount: number;
			globePresentCount: number;
			isComplete: boolean;
			hasAnyMissing: boolean;
		};
	};

	const cities = data.cities as City[];
	const report = $derived(data.report);
	const allFiles = data.allFiles as string[];
	const categories = data.categories;

	// State
	let q = $state('');
	let selectedCategory = $state<string>('all');
	let filterFile = $state<string | null>(null);
	let onlyMissing = $state(false);
	let onlyComplete = $state(false);
	let sort = $state<'name' | 'missing' | 'pop'>('name');
	let savingRegistry = $state(false);
	let toastMessage = $state<string | null>(null);

	function showToast(msg: string) {
		toastMessage = msg;
		setTimeout(() => {
			if (toastMessage === msg) toastMessage = null;
		}, 3000);
	}

	// Active files to display based on category tab
	const activeFiles = $derived.by(() => {
		if (selectedCategory === 'all') return allFiles;
		const cat = categories.find((c: any) => c.id === selectedCategory);
		return cat ? cat.files : allFiles;
	});

	// Filtered city rows
	const filteredCities = $derived.by(() => {
		const query = q.trim().toLowerCase();
		let rows = cities.filter((c) => {
			if (onlyMissing && !c.storage19?.hasAnyMissing) return false;
			if (onlyComplete && !c.storage19?.isComplete) return false;
			if (filterFile) {
				const hasDl = c.storage19?.datalake[filterFile];
				const hasGl = c.storage19?.globe[filterFile];
				if (hasDl && hasGl) return false;
			}
			if (query) {
				const matchName = c.name.toLowerCase().includes(query);
				const matchSlug = c.slug.toLowerCase().includes(query);
				const matchCont = c.continent.toLowerCase().includes(query);
				if (!matchName && !matchSlug && !matchCont) return false;
			}
			return true;
		});

		rows = [...rows];
		if (sort === 'name') {
			rows.sort((a, b) => a.name.localeCompare(b.name));
		} else if (sort === 'pop') {
			rows.sort((a, b) => (b.pop || 0) - (a.pop || 0));
		} else if (sort === 'missing') {
			rows.sort((a, b) => {
				const aMiss = (a.storage19?.missing.datalake.length || 0) + (a.storage19?.missing.globe.length || 0);
				const bMiss = (b.storage19?.missing.datalake.length || 0) + (b.storage19?.missing.globe.length || 0);
				return bMiss - aMiss || a.name.localeCompare(b.name);
			});
		}

		return rows;
	});

	function copyS3(bucket: 'geo-datalake' | 'globe', slug: string, file: string) {
		const uri = bucket === 'geo-datalake'
			? `s3://geo-datalake/sources/city-network/${slug}/${file}`
			: `s3://globe/data/${slug}-2d/${file}`;
		if (navigator.clipboard) navigator.clipboard.writeText(uri).catch(() => {});
		showToast(`Copied ${uri}`);
	}

	function downloadJson() {
		const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `atlas-19-files-report-${new Date().toISOString().slice(0, 10)}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}
</script>

<svelte:head>
	<title>Atlas JSON / 19-Files Architecture · Geo Admin</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-full space-y-5 px-3 py-5 sm:px-6 sm:py-8">
	<!-- Header -->
	<div class="flex flex-wrap items-center justify-between gap-4">
		<div>
			<div class="flex items-center gap-2">
				<h1 class="text-2xl font-bold tracking-tight">Atlas JSON & Binary Architecture</h1>
				<Badge variant="outline" class="border-sky-500/40 bg-sky-500/10 text-sky-500 font-mono text-xs">
					19 Raw Files Schema
				</Badge>
			</div>
			<p class="mt-1 text-sm text-muted-foreground">
				Tracking granular urban datasets across {data.totalCities} cities in R2 (<span class="font-mono">geo-datalake</span> and <span class="font-mono">globe</span>).
				Provides fine-grained layer isolation for MapLibre WebGL, routing, and transit models.
			</p>
		</div>

		<div class="flex flex-wrap items-center gap-2 text-xs">
			<a
				href="/dashboard/geo-site/content/atlas-dashboard"
				class="inline-flex h-8 items-center justify-center rounded-md border border-input bg-background px-3 text-xs font-medium hover:bg-accent hover:text-accent-foreground"
			>
				&larr; Switch to Atlas Coverage (Families)
			</a>
			<Button
				type="button"
				variant="outline"
				size="sm"
				class="h-8 text-xs cursor-pointer"
				onclick={downloadJson}
			>
				Download Registry (.json)
			</Button>
			<form
				method="POST"
				action="?/saveRegistry"
				use:enhance={() => {
					savingRegistry = true;
					return async ({ update }) => {
						await update();
						savingRegistry = false;
						showToast('19-files registry saved to R2');
					};
				}}
			>
				<Button
					type="submit"
					variant="outline"
					size="sm"
					class="h-8 text-xs"
					disabled={savingRegistry}
				>
					{savingRegistry ? 'Saving…' : 'Save Registry to R2'}
				</Button>
			</form>
		</div>
	</div>

	<!-- Toast Notification -->
	{#if toastMessage}
		<div class="fixed bottom-4 right-4 z-50 rounded-md bg-foreground px-4 py-2 text-xs font-medium text-background shadow-lg transition-all animate-in fade-in slide-in-from-bottom-2">
			{toastMessage}
		</div>
	{/if}

	<!-- Category Tab Filter -->
	<div class="flex flex-wrap items-center gap-1.5 border-b border-border pb-2 text-xs">
		<button
			type="button"
			class={[
				'rounded-md px-3 py-1.5 font-medium transition cursor-pointer',
				selectedCategory === 'all'
					? 'bg-primary text-primary-foreground'
					: 'bg-muted/50 text-muted-foreground hover:bg-muted'
			]}
			onclick={() => { selectedCategory = 'all'; filterFile = null; }}
		>
			All 19 Files ({allFiles.length})
		</button>
		{#each categories as cat (cat.id)}
			<button
				type="button"
				class={[
					'rounded-md px-3 py-1.5 font-medium transition cursor-pointer',
					selectedCategory === cat.id
						? 'bg-primary text-primary-foreground'
						: 'bg-muted/50 text-muted-foreground hover:bg-muted'
				]}
				onclick={() => { selectedCategory = cat.id; filterFile = null; }}
				title={cat.description}
			>
				{cat.name} ({cat.files.length})
			</button>
		{/each}
	</div>

	<!-- 19-Files Interactive Metric Cards -->
	{#if report}
		<div class="grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-7 xl:grid-cols-10">
			{#each activeFiles as file (file)}
				{@const dlTot = report.totals.datalake[file]}
				{@const glTot = report.totals.globe[file]}
				{@const isFiltered = filterFile === file}
				<button
					type="button"
					class={[
						'group relative flex flex-col justify-between rounded-lg border p-2 text-left transition cursor-pointer',
						isFiltered
							? 'border-sky-500 bg-sky-500/10 ring-1 ring-sky-500'
							: 'border-border/60 bg-card hover:border-border hover:bg-accent/40'
					]}
					onclick={() => filterFile = isFiltered ? null : file}
					title="Click to filter table by missing {file}"
				>
					<div>
						<span class="block truncate font-mono text-[11px] font-semibold text-foreground group-hover:text-primary">
							{file}
						</span>
						<span class="block text-[10px] text-muted-foreground">
							{file.endsWith('.bin') ? 'Binary (Wasm)' : 'GeoJSON / Matrix'}
						</span>
					</div>

					<div class="mt-2 flex items-baseline justify-between text-xs tabular-nums">
						<span class="font-bold text-teal-600 dark:text-teal-400">
							{glTot?.present ?? 0}
						</span>
						{#if (glTot?.missing ?? 0) > 0}
							<span class="text-[10px] font-medium text-rose-500">
								{glTot?.missing} miss
							</span>
						{:else}
							<span class="text-[10px] font-medium text-emerald-500">100%</span>
						{/if}
					</div>
				</button>
			{/each}
		</div>
	{/if}

	<!-- Search & Table Control Bar -->
	<div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-card p-3 text-xs">
		<div class="flex flex-wrap items-center gap-3">
			<div class="w-64">
				<Input
					bind:value={q}
					placeholder="Search city, slug, continent…"
					class="h-8 text-xs"
				/>
			</div>

			<label class="flex items-center gap-1.5 cursor-pointer select-none">
				<Checkbox bind:checked={onlyMissing} />
				<span>Missing files only</span>
			</label>

			<label class="flex items-center gap-1.5 cursor-pointer select-none">
				<Checkbox bind:checked={onlyComplete} />
				<span>Complete (17+ files) only</span>
			</label>

			{#if filterFile}
				<Badge variant="outline" class="flex items-center gap-1 border-sky-500 text-sky-600 bg-sky-500/10">
					Filtered: {filterFile}
					<button type="button" class="ml-1 hover:text-foreground cursor-pointer" onclick={() => filterFile = null}>&times;</button>
				</Badge>
			{/if}
		</div>

		<div class="flex items-center gap-2">
			<span class="text-muted-foreground">Sort:</span>
			<button
				type="button"
				class={['px-2 py-1 rounded text-xs transition cursor-pointer', sort === 'name' ? 'bg-primary text-primary-foreground font-medium' : 'hover:bg-muted']}
				onclick={() => sort = 'name'}
			>
				Name
			</button>
			<button
				type="button"
				class={['px-2 py-1 rounded text-xs transition cursor-pointer', sort === 'missing' ? 'bg-primary text-primary-foreground font-medium' : 'hover:bg-muted']}
				onclick={() => sort = 'missing'}
			>
				Most Missing
			</button>
			<button
				type="button"
				class={['px-2 py-1 rounded text-xs transition cursor-pointer', sort === 'pop' ? 'bg-primary text-primary-foreground font-medium' : 'hover:bg-muted']}
				onclick={() => sort = 'pop'}
			>
				Population
			</button>
			<span class="text-muted-foreground ml-2">({filteredCities.length} cities)</span>
		</div>
	</div>

	<!-- Interactive Cities Grid Table -->
	<div class="overflow-x-auto rounded-lg border border-border bg-card">
		<table class="w-full text-left text-xs">
			<thead class="border-b border-border bg-muted/40 font-medium text-muted-foreground">
				<tr>
					<th class="p-2.5 pl-3 min-w-[200px]">City & Region</th>
					<th class="p-2.5 text-center w-28">Status</th>
					{#each activeFiles as file (file)}
						<th class="p-2 text-center truncate max-w-[110px]" title={file}>
							<span class="font-mono text-[10px]">{file.replace('.json', '').replace('.bin', '')}</span>
						</th>
					{/each}
				</tr>
			</thead>
			<tbody class="divide-y divide-border/60">
				{#each filteredCities as city (city.slug)}
					{@const st = city.storage19}
					<tr class="hover:bg-muted/30 transition-colors">
						<td class="p-2.5 pl-3">
							<div class="flex items-baseline gap-2">
								<span class="font-semibold text-foreground">{city.name}</span>
								<span class="text-[10px] text-muted-foreground font-mono">({city.slug})</span>
							</div>
							<div class="text-[10px] text-muted-foreground">
								{city.continent} · Pop {(city.pop || 0).toLocaleString()}
							</div>
						</td>

						<td class="p-2 text-center">
							{#if st?.isComplete}
								<Badge variant="outline" class="border-emerald-500/40 bg-emerald-500/10 text-emerald-500 text-[10px]">
									Complete
								</Badge>
							{:else}
								<Badge variant="outline" class="border-amber-500/40 bg-amber-500/10 text-amber-500 text-[10px]">
									{st?.globePresentCount ?? 0}/{allFiles.length}
								</Badge>
							{/if}
						</td>

						{#each activeFiles as file (file)}
							{@const hasDl = st?.datalake[file]}
							{@const hasGl = st?.globe[file]}
							<td class="p-1.5 text-center">
								<div class="inline-flex items-center justify-center">
									{#if hasGl}
										<button
											type="button"
											class="size-6 rounded bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 font-bold hover:bg-emerald-500/30 transition cursor-pointer flex items-center justify-center text-[11px]"
											onclick={() => copyS3('globe', city.slug, file)}
											title="{city.name} - {file} (Available in R2 globe)\nClick to copy S3 URI"
										>
											✓
										</button>
									{:else if hasDl}
										<button
											type="button"
											class="size-6 rounded bg-teal-500/20 text-teal-600 dark:text-teal-400 font-bold hover:bg-teal-500/30 transition cursor-pointer flex items-center justify-center text-[11px]"
											onclick={() => copyS3('geo-datalake', city.slug, file)}
											title="{city.name} - {file} (In geo-datalake only)\nClick to copy S3 URI"
										>
											DL
										</button>
									{:else}
										<span
											class="size-6 rounded bg-rose-500/10 text-rose-500/70 font-mono text-[10px] flex items-center justify-center select-none"
											title="{city.name} - {file} (Missing in R2)"
										>
											-
										</span>
									{/if}
								</div>
							</td>
						{/each}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>
