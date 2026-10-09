<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { enhance } from '$app/forms';

	let { data } = $props();

	const previewOrigin = 'https://preview-geo-astro-site.foodstarmelbourne.workers.dev';
	function previewMapHref(slug: string): string {
		return `${previewOrigin}/maps/${slug}`;
	}

	type MapItem = {
		slug: string;
		title: string;
		category: string;
		description: string;
		featuresCount: number;
		hasYears: boolean;
		yearsCount: number;
		years: number[] | null;
		files: Record<string, boolean>;
		missing: string[];
		isComplete: boolean;
		r2Path: string;
		previewUrl: string;
	};

	const maps = data.maps as MapItem[];
	const report = $derived(data.report);
	const allFiles = data.allFiles as string[];
	const categories = data.categories;

	// State
	let q = $state('');
	let selectedCategory = $state<string>('all');
	let filterFile = $state<string | null>(null);
	let onlyTemporal = $state(false);
	let onlyMissing = $state(false);
	let onlyComplete = $state(false);
	let sort = $state<'features' | 'title' | 'years' | 'missing'>('features');
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

	// Filtered map rows
	const filteredMaps = $derived.by(() => {
		const query = q.trim().toLowerCase();
		let rows = maps.filter((m) => {
			if (onlyMissing && m.isComplete) return false;
			if (onlyComplete && !m.isComplete) return false;
			if (onlyTemporal && !m.hasYears) return false;
			if (filterFile) {
				const hasFile = m.files[filterFile];
				if (hasFile) return false;
			}
			if (query) {
				const matchTitle = m.title.toLowerCase().includes(query);
				const matchSlug = m.slug.toLowerCase().includes(query);
				const matchCat = (m.category || '').toLowerCase().includes(query);
				const matchDesc = (m.description || '').toLowerCase().includes(query);
				if (!matchTitle && !matchSlug && !matchCat && !matchDesc) return false;
			}
			return true;
		});

		rows = [...rows];
		if (sort === 'title') {
			rows.sort((a, b) => a.title.localeCompare(b.title));
		} else if (sort === 'features') {
			rows.sort((a, b) => (b.featuresCount || 0) - (a.featuresCount || 0) || a.title.localeCompare(b.title));
		} else if (sort === 'years') {
			rows.sort((a, b) => (b.yearsCount || 0) - (a.yearsCount || 0) || a.title.localeCompare(b.title));
		} else if (sort === 'missing') {
			rows.sort((a, b) => (b.missing.length || 0) - (a.missing.length || 0) || a.title.localeCompare(b.title));
		}

		return rows;
	});

	function copyS3(slug: string, file: string) {
		const uri = `s3://globe/data/maps/${slug}/${file}`;
		if (navigator.clipboard) navigator.clipboard.writeText(uri).catch(() => {});
		showToast(`Copied ${uri}`);
	}

	function downloadJson() {
		const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `maps-json-report-${new Date().toISOString().slice(0, 10)}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}
</script>

<svelte:head>
	<title>Maps JSON Architecture · Geo Admin</title>
</svelte:head>

<div class="space-y-6 p-6">
	<!-- Toast -->
	{#if toastMessage}
		<div
			class="fixed bottom-6 right-6 z-50 rounded-lg bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white shadow-xl dark:bg-white dark:text-neutral-900 transition-all"
		>
			{toastMessage}
		</div>
	{/if}

	<!-- Header -->
	<div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
		<div>
			<div class="flex items-center gap-3">
				<h1 class="text-2xl font-bold tracking-tight text-neutral-900 dark:text-neutral-100">
					Maps JSON Architecture
				</h1>
				<Badge variant="outline" class="font-mono text-xs">
					{report.source === 'live-r2' ? 'Live R2 Scan' : 'Registry Cache'}
				</Badge>
			</div>
			<p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
				Monitoring R2 <code>globe/data/maps/&lt;slug&gt;/</code> dataset packages:
				<code>pack.json</code>, <code>data.json</code>, <code>pois.json</code>, and <code>landmarks.json</code>.
			</p>
		</div>

		<div class="flex items-center gap-2">
			<form
				method="POST"
				action="?/saveRegistry"
				use:enhance={() => {
					savingRegistry = true;
					return async ({ update }) => {
						savingRegistry = false;
						await update();
						showToast('Maps registry synced to R2');
					};
				}}
			>
				<Button type="submit" variant="outline" size="sm" disabled={savingRegistry}>
					{savingRegistry ? 'Saving...' : 'Save Registry to R2'}
				</Button>
			</form>
			<Button variant="outline" size="sm" onclick={downloadJson}>
				Export JSON Report
			</Button>
		</div>
	</div>

	<!-- Metric Cards -->
	<div class="grid grid-cols-2 gap-4 md:grid-cols-5">
		<div class="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
			<div class="text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Total Maps Datasets</div>
			<div class="mt-2 text-2xl font-bold text-neutral-900 dark:text-neutral-100">{report.totals.totalMaps}</div>
			<div class="mt-1 text-xs text-neutral-400">Thematic & temporal</div>
		</div>

		<div class="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
			<div class="text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Complete R2 Bundles</div>
			<div class="mt-2 text-2xl font-bold text-emerald-600 dark:text-emerald-400">
				{report.totals.mapsComplete} / {report.totals.totalMaps}
			</div>
			<div class="mt-1 text-xs text-neutral-400">
				{Math.round((report.totals.mapsComplete / Math.max(1, report.totals.totalMaps)) * 100)}% 4/4 files present
			</div>
		</div>

		<div class="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
			<div class="text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Temporal Time-Series</div>
			<div class="mt-2 text-2xl font-bold text-violet-600 dark:text-violet-400">
				{report.totals.temporalMapsCount}
			</div>
			<div class="mt-1 text-xs text-neutral-400">Multi-year slider series</div>
		</div>

		<div class="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
			<div class="text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Total Mapped Points</div>
			<div class="mt-2 text-2xl font-bold text-indigo-600 dark:text-indigo-400">
				{report.totals.totalFeatures.toLocaleString()}
			</div>
			<div class="mt-1 text-xs text-neutral-400">Aggregate feature count</div>
		</div>

		<div class="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
			<div class="text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Target Endpoint</div>
			<div class="mt-2 text-base font-bold font-mono text-cyan-600 dark:text-cyan-400 truncate">
				/data/maps/[slug]/pack.json
			</div>
			<div class="mt-1 text-xs text-neutral-400">Zero-bundle client fetch</div>
		</div>
	</div>

	<!-- Controls & Filter Toolbar -->
	<div class="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900 space-y-4">
		<div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
			<!-- Search -->
			<div class="relative flex-1 max-w-sm">
				<Input
					type="search"
					placeholder="Filter by title, slug, category, description..."
					bind:value={q}
					class="w-full text-sm"
				/>
			</div>

			<!-- Sort and Filters -->
			<div class="flex flex-wrap items-center gap-4 text-sm">
				<div class="flex items-center gap-2">
					<Checkbox id="onlyTemporal" bind:checked={onlyTemporal} />
					<label for="onlyTemporal" class="text-xs font-medium cursor-pointer">Only Temporal (Years)</label>
				</div>

				<div class="flex items-center gap-2">
					<Checkbox id="onlyComplete" bind:checked={onlyComplete} />
					<label for="onlyComplete" class="text-xs font-medium cursor-pointer">Only Complete</label>
				</div>

				<div class="flex items-center gap-2">
					<Checkbox id="onlyMissing" bind:checked={onlyMissing} />
					<label for="onlyMissing" class="text-xs font-medium cursor-pointer">Has Missing</label>
				</div>

				<div class="flex items-center gap-2">
					<span class="text-xs text-neutral-500">Sort:</span>
					<select
						bind:value={sort}
						class="rounded-md border border-neutral-200 bg-transparent px-2.5 py-1 text-xs font-medium dark:border-neutral-800"
					>
						<option value="features">Features / Points</option>
						<option value="years">Temporal Years</option>
						<option value="title">Dataset Title</option>
						<option value="missing">Missing Files</option>
					</select>
				</div>
			</div>
		</div>

		<!-- Category Tabs -->
		<div class="flex flex-wrap items-center gap-1 border-t border-neutral-100 pt-3 dark:border-neutral-800">
			<button
				type="button"
				onclick={() => { selectedCategory = 'all'; filterFile = null; }}
				class={[
					'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
					selectedCategory === 'all'
						? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900'
						: 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800'
				]}
			>
				All 4 Standard Files
			</button>

			{#each categories as cat}
				<button
					type="button"
					onclick={() => { selectedCategory = cat.id; filterFile = null; }}
					class={[
						'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
						selectedCategory === cat.id
							? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900'
							: 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800'
					]}
				>
					{cat.name}
				</button>
			{/each}
		</div>
	</div>

	<!-- Results Table -->
	<div class="rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900 overflow-hidden">
		<div class="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
			<div class="text-xs font-medium text-neutral-500">
				Showing {filteredMaps.length} of {maps.length} Maps Datasets
			</div>
		</div>

		<div class="overflow-x-auto">
			<table class="w-full text-left text-sm">
				<thead class="border-b border-neutral-200 bg-neutral-50/50 text-xs uppercase text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/50">
					<tr>
						<th class="px-4 py-3 font-medium">Dataset / Title</th>
						<th class="px-4 py-3 font-medium">Category / Mode</th>
						<th class="px-4 py-3 font-medium text-right">Features</th>
						<th class="px-4 py-3 font-medium text-center">Status</th>
						<th class="px-4 py-3 font-medium">Files In R2 (globe/data/maps/)</th>
						<th class="px-4 py-3 font-medium text-right">Actions</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-neutral-200 dark:divide-neutral-800">
					{#each filteredMaps as map (map.slug)}
						<tr class="hover:bg-neutral-50/50 dark:hover:bg-neutral-800/50 transition-colors">
							<td class="px-4 py-3 max-w-xs">
								<div class="font-medium text-neutral-900 dark:text-neutral-100 truncate" title={map.title}>
									{map.title}
								</div>
								<div class="font-mono text-xs text-neutral-400 truncate">{map.slug}</div>
							</td>
							<td class="px-4 py-3 text-xs text-neutral-500">
								<div class="flex items-center gap-1.5 flex-wrap">
									<Badge variant="outline" class="text-[11px]">
										{map.category || 'Thematic'}
									</Badge>
									{#if map.hasYears}
										<Badge class="bg-violet-500/10 text-violet-600 dark:text-violet-400 hover:bg-violet-500/20 text-[11px]">
											{map.yearsCount} Years
										</Badge>
									{/if}
								</div>
							</td>
							<td class="px-4 py-3 text-right font-mono text-xs font-semibold text-indigo-600 dark:text-indigo-400">
								{map.featuresCount.toLocaleString()}
							</td>
							<td class="px-4 py-3 text-center">
								{#if map.isComplete}
									<Badge class="bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 text-xs">
										4/4 Ready
									</Badge>
								{:else}
									<Badge variant="destructive" class="text-xs">
										{map.missing.length} missing
									</Badge>
								{/if}
							</td>
							<td class="px-4 py-3">
								<div class="flex flex-wrap items-center gap-1.5">
									{#each activeFiles as file}
										{@const present = map.files[file]}
										<button
											type="button"
											onclick={() => copyS3(map.slug, file)}
											title={`s3://globe/data/maps/${map.slug}/${file} (${present ? 'present' : 'missing'})`}
											class={[
												'inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[11px] transition-colors',
												present
													? 'bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-400'
													: 'bg-red-500/10 text-red-600 hover:bg-red-500/20 dark:text-red-400'
											]}
										>
											<span class={['h-1.5 w-1.5 rounded-full', present ? 'bg-emerald-500' : 'bg-red-500']}></span>
											{file}
										</button>
									{/each}
								</div>
							</td>
							<td class="px-4 py-3 text-right">
								<a
									href={previewMapHref(map.slug)}
									target="_blank"
									rel="noreferrer"
									class="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
								>
									Preview Map &rarr;
								</a>
							</td>
						</tr>
					{:else}
						<tr>
							<td colspan="6" class="px-4 py-8 text-center text-sm text-neutral-500">
								No maps datasets found matching your query.
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
</div>
