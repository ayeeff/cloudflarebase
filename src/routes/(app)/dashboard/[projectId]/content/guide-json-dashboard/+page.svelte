<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { enhance } from '$app/forms';

	let { data } = $props();

	const previewOrigin = 'https://preview-geo-astro-site.foodstarmelbourne.workers.dev';
	function previewGuideHref(slug: string): string {
		return `${previewOrigin}/guide/${slug}`;
	}

	type GuideCity = {
		slug: string;
		name: string;
		country: string;
		continent: string;
		pop: number;
		poisCount: number;
		landmarksCount: number;
		files: Record<string, boolean>;
		missing: string[];
		isComplete: boolean;
		r2Path: string;
		previewUrl: string;
	};

	const guides = data.guides as GuideCity[];
	const report = $derived(data.report);
	const allFiles = data.allFiles as string[];
	const categories = data.categories;

	// State
	let q = $state('');
	let selectedCategory = $state<string>('all');
	let filterFile = $state<string | null>(null);
	let onlyMissing = $state(false);
	let onlyComplete = $state(false);
	let sort = $state<'name' | 'missing' | 'pois' | 'landmarks'>('pois');
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

	// Filtered guide rows
	const filteredGuides = $derived.by(() => {
		const query = q.trim().toLowerCase();
		let rows = guides.filter((g) => {
			if (onlyMissing && g.isComplete) return false;
			if (onlyComplete && !g.isComplete) return false;
			if (filterFile) {
				const hasFile = g.files[filterFile];
				if (hasFile) return false;
			}
			if (query) {
				const matchName = g.name.toLowerCase().includes(query);
				const matchSlug = g.slug.toLowerCase().includes(query);
				const matchCountry = (g.country || '').toLowerCase().includes(query);
				const matchCont = g.continent.toLowerCase().includes(query);
				if (!matchName && !matchSlug && !matchCountry && !matchCont) return false;
			}
			return true;
		});

		rows = [...rows];
		if (sort === 'name') {
			rows.sort((a, b) => a.name.localeCompare(b.name));
		} else if (sort === 'pois') {
			rows.sort((a, b) => (b.poisCount || 0) - (a.poisCount || 0) || a.name.localeCompare(b.name));
		} else if (sort === 'landmarks') {
			rows.sort((a, b) => (b.landmarksCount || 0) - (a.landmarksCount || 0) || a.name.localeCompare(b.name));
		} else if (sort === 'missing') {
			rows.sort((a, b) => (b.missing.length || 0) - (a.missing.length || 0) || a.name.localeCompare(b.name));
		}

		return rows;
	});

	function copyS3(slug: string, file: string) {
		const uri = `s3://globe/data/guide/${slug}/${file}`;
		if (navigator.clipboard) navigator.clipboard.writeText(uri).catch(() => {});
		showToast(`Copied ${uri}`);
	}

	function downloadJson() {
		const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `guide-json-report-${new Date().toISOString().slice(0, 10)}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}
</script>

<svelte:head>
	<title>Guide JSON Architecture · Geo Admin</title>
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
					City Guide JSON Architecture
				</h1>
				<Badge variant="outline" class="font-mono text-xs">
					{report.source === 'live-r2' ? 'Live R2 Scan' : 'Registry Cache'}
				</Badge>
			</div>
			<p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
				Monitoring R2 <code>globe/data/guide/&lt;slug&gt;/</code> dataset packages:
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
						showToast('Guide registry synced to R2');
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
			<div class="text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Total City Guides</div>
			<div class="mt-2 text-2xl font-bold text-neutral-900 dark:text-neutral-100">{report.totals.totalGuides}</div>
			<div class="mt-1 text-xs text-neutral-400">Published cities</div>
		</div>

		<div class="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
			<div class="text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Complete R2 Bundles</div>
			<div class="mt-2 text-2xl font-bold text-emerald-600 dark:text-emerald-400">
				{report.totals.guidesComplete} / {report.totals.totalGuides}
			</div>
			<div class="mt-1 text-xs text-neutral-400">
				{Math.round((report.totals.guidesComplete / Math.max(1, report.totals.totalGuides)) * 100)}% 4/4 files present
			</div>
		</div>

		<div class="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
			<div class="text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Total Amenities & POIs</div>
			<div class="mt-2 text-2xl font-bold text-indigo-600 dark:text-indigo-400">
				{report.totals.totalPois.toLocaleString()}
			</div>
			<div class="mt-1 text-xs text-neutral-400">Aggregated OSM points</div>
		</div>

		<div class="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
			<div class="text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Curated Gold POIs</div>
			<div class="mt-2 text-2xl font-bold text-amber-500">
				{report.totals.totalLandmarks.toLocaleString()}
			</div>
			<div class="mt-1 text-xs text-neutral-400">Priority landmarks</div>
		</div>

		<div class="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
			<div class="text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Target Endpoint</div>
			<div class="mt-2 text-base font-bold font-mono text-cyan-600 dark:text-cyan-400 truncate">
				/data/guide/[slug]/pack.json
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
					placeholder="Filter by city, slug, or country..."
					bind:value={q}
					class="w-full text-sm"
				/>
			</div>

			<!-- Sort and Filters -->
			<div class="flex flex-wrap items-center gap-4 text-sm">
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
						<option value="pois">Total POIs</option>
						<option value="landmarks">Curated Landmarks</option>
						<option value="name">City Name</option>
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
				Showing {filteredGuides.length} of {guides.length} City Guides
			</div>
		</div>

		<div class="overflow-x-auto">
			<table class="w-full text-left text-sm">
				<thead class="border-b border-neutral-200 bg-neutral-50/50 text-xs uppercase text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/50">
					<tr>
						<th class="px-4 py-3 font-medium">City Guide</th>
						<th class="px-4 py-3 font-medium">Region</th>
						<th class="px-4 py-3 font-medium text-right">POIs</th>
						<th class="px-4 py-3 font-medium text-right">Curated</th>
						<th class="px-4 py-3 font-medium text-center">Status</th>
						<th class="px-4 py-3 font-medium">Files In R2 (globe/data/guide/)</th>
						<th class="px-4 py-3 font-medium text-right">Actions</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-neutral-200 dark:divide-neutral-800">
					{#each filteredGuides as guide (guide.slug)}
						<tr class="hover:bg-neutral-50/50 dark:hover:bg-neutral-800/50 transition-colors">
							<td class="px-4 py-3">
								<div class="font-medium text-neutral-900 dark:text-neutral-100">{guide.name}</div>
								<div class="font-mono text-xs text-neutral-400">{guide.slug}</div>
							</td>
							<td class="px-4 py-3 text-xs text-neutral-500">
								<div>{guide.country}</div>
								<div class="text-neutral-400">{guide.continent}</div>
							</td>
							<td class="px-4 py-3 text-right font-mono text-xs font-semibold text-indigo-600 dark:text-indigo-400">
								{guide.poisCount.toLocaleString()}
							</td>
							<td class="px-4 py-3 text-right font-mono text-xs font-semibold text-amber-500">
								{guide.landmarksCount.toLocaleString()}
							</td>
							<td class="px-4 py-3 text-center">
								{#if guide.isComplete}
									<Badge class="bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 text-xs">
										4/4 Ready
									</Badge>
								{:else}
									<Badge variant="destructive" class="text-xs">
										{guide.missing.length} missing
									</Badge>
								{/if}
							</td>
							<td class="px-4 py-3">
								<div class="flex flex-wrap items-center gap-1.5">
									{#each activeFiles as file}
										{@const present = guide.files[file]}
										<button
											type="button"
											onclick={() => copyS3(guide.slug, file)}
											title={`s3://globe/data/guide/${guide.slug}/${file} (${present ? 'present' : 'missing'})`}
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
									href={previewGuideHref(guide.slug)}
									target="_blank"
									rel="noreferrer"
									class="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
								>
									Preview Guide &rarr;
								</a>
							</td>
						</tr>
					{:else}
						<tr>
							<td colspan="7" class="px-4 py-8 text-center text-sm text-neutral-500">
								No city guides found matching your query.
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
</div>
