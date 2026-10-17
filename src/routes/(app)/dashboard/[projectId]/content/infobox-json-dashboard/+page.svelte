<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { enhance } from '$app/forms';

	let { data } = $props();

	const previewOrigin = 'https://preview-geo-astro-site.foodstarmelbourne.workers.dev';
	function previewGuideHref(slug: string): string {
		return `${previewOrigin}/guide/${slug}`;
	}

	type InfoboxCity = {
		slug: string;
		name: string;
		country: string;
		continent: string;
		pop: number;
		hasInfobox: boolean;
		neighborhoodsCount: number;
		neighborhoodsList: string[];
		r2Path: string;
		previewUrl: string;
	};

	const cities = data.cities as InfoboxCity[];
	const report = $derived(data.report);

	// State
	let q = $state('');
	let filterStatus = $state<'all' | 'staged' | 'pending'>('all');
	let sort = $state<'pop' | 'name' | 'neighborhoods'>('pop');
	let savingRegistry = $state(false);
	let toastMessage = $state<string | null>(null);

	function showToast(msg: string) {
		toastMessage = msg;
		setTimeout(() => {
			if (toastMessage === msg) toastMessage = null;
		}, 3000);
	}

	// Filtered city rows
	const filteredCities = $derived.by(() => {
		const query = q.trim().toLowerCase();
		let rows = cities.filter((c) => {
			if (filterStatus === 'staged' && !c.hasInfobox) return false;
			if (filterStatus === 'pending' && c.hasInfobox) return false;
			if (query) {
				const matchName = c.name.toLowerCase().includes(query);
				const matchSlug = c.slug.toLowerCase().includes(query);
				const matchCountry = (c.country || '').toLowerCase().includes(query);
				const matchCont = (c.continent || '').toLowerCase().includes(query);
				if (!matchName && !matchSlug && !matchCountry && !matchCont) return false;
			}
			return true;
		});

		rows = [...rows];
		if (sort === 'name') {
			rows.sort((a, b) => a.name.localeCompare(b.name));
		} else if (sort === 'pop') {
			rows.sort((a, b) => (b.hasInfobox ? 1 : 0) - (a.hasInfobox ? 1 : 0) || (b.pop || 0) - (a.pop || 0) || a.name.localeCompare(b.name));
		} else if (sort === 'neighborhoods') {
			rows.sort((a, b) => (b.neighborhoodsCount || 0) - (a.neighborhoodsCount || 0) || a.name.localeCompare(b.name));
		}

		return rows;
	});

	function copyS3(slug: string) {
		const uri = `s3://globe/data/${slug}-2d/Infobox.json`;
		if (navigator.clipboard) navigator.clipboard.writeText(uri).catch(() => {});
		showToast(`Copied ${uri}`);
	}

	function downloadJson() {
		const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `infobox-json-report-${new Date().toISOString().slice(0, 10)}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}
</script>

<svelte:head>
	<title>Infobox JSON Architecture · Geo Admin</title>
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
					City AI Infobox JSON Architecture
				</h1>
				<Badge variant="outline" class="font-mono text-xs">
					{report.source === 'live-r2' ? 'Live R2 Scan' : 'Registry Cache'}
				</Badge>
			</div>
			<p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
				Tracking R2 <code>globe/data/&lt;slug&gt;-2d/Infobox.json</code> AI summaries (Walking tours, History, Food scene, Hidden gems).
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
						showToast('Infobox registry synced to R2');
					};
				}}
			>
				<Button type="submit" variant="outline" size="sm" disabled={savingRegistry}>
					{savingRegistry ? 'Saving...' : 'Sync Registry to R2'}
				</Button>
			</form>
			<Button variant="outline" size="sm" onclick={downloadJson}>Export JSON</Button>
		</div>
	</div>

	<!-- Top Metrics Grid -->
	<div class="grid grid-cols-2 gap-4 md:grid-cols-4">
		<div class="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
			<div class="text-xs font-medium text-neutral-500 dark:text-neutral-400">Total 2D Cities</div>
			<div class="mt-1 text-2xl font-bold tracking-tight text-neutral-900 dark:text-neutral-100">
				{report.totals.totalCities.toLocaleString()}
			</div>
			<div class="mt-1 text-xs text-neutral-400">100% indexed in R2</div>
		</div>

		<div class="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
			<div class="text-xs font-medium text-neutral-500 dark:text-neutral-400">Staged Infoboxes</div>
			<div class="mt-1 text-2xl font-bold tracking-tight text-emerald-600 dark:text-emerald-400">
				{report.totals.citiesWithInfobox.toLocaleString()}
			</div>
			<div class="mt-1 text-xs text-emerald-500">Instant 0ms edge cached</div>
		</div>

		<div class="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
			<div class="text-xs font-medium text-neutral-500 dark:text-neutral-400">Pending Live Cities</div>
			<div class="mt-1 text-2xl font-bold tracking-tight text-amber-600 dark:text-amber-400">
				{report.totals.citiesPending.toLocaleString()}
			</div>
			<div class="mt-1 text-xs text-amber-500">Live Gemini fallback</div>
		</div>

		<div class="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
			<div class="text-xs font-medium text-neutral-500 dark:text-neutral-400">Enriched Neighbourhoods</div>
			<div class="mt-1 text-2xl font-bold tracking-tight text-sky-600 dark:text-sky-400">
				{report.totals.totalNeighborhoodSummaries.toLocaleString()}
			</div>
			<div class="mt-1 text-xs text-sky-500">Full 3-dimension AI guides</div>
		</div>
	</div>

	<!-- Controls & Filters -->
	<div class="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900 md:flex-row md:items-center md:justify-between">
		<div class="flex flex-1 items-center gap-3">
			<div class="relative w-full max-w-sm">
				<Input
					bind:value={q}
					placeholder="Search city, slug, country..."
					class="h-9 w-full bg-neutral-50 dark:bg-neutral-800"
				/>
			</div>

			<div class="flex items-center gap-1 rounded-lg border border-neutral-200 p-1 dark:border-neutral-800">
				<button
					type="button"
					onclick={() => (filterStatus = 'all')}
					class={[
						'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
						filterStatus === 'all'
							? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
							: 'text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100'
					]}
				>
					All ({cities.length})
				</button>
				<button
					type="button"
					onclick={() => (filterStatus = 'staged')}
					class={[
						'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
						filterStatus === 'staged'
							? 'bg-emerald-600 text-white'
							: 'text-neutral-600 hover:text-emerald-600 dark:text-neutral-400'
					]}
				>
					Staged ({report.totals.citiesWithInfobox})
				</button>
				<button
					type="button"
					onclick={() => (filterStatus = 'pending')}
					class={[
						'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
						filterStatus === 'pending'
							? 'bg-amber-600 text-white'
							: 'text-neutral-600 hover:text-amber-600 dark:text-neutral-400'
					]}
				>
					Pending ({report.totals.citiesPending})
				</button>
			</div>
		</div>

		<div class="flex items-center gap-2 text-xs text-neutral-500">
			<span>Sort:</span>
			<button
				type="button"
				onclick={() => (sort = 'pop')}
				class={['font-medium hover:underline', sort === 'pop' ? 'text-primary' : '']}
			>
				Population
			</button>
			<span>·</span>
			<button
				type="button"
				onclick={() => (sort = 'neighborhoods')}
				class={['font-medium hover:underline', sort === 'neighborhoods' ? 'text-primary' : '']}
			>
				Neighbourhoods
			</button>
			<span>·</span>
			<button
				type="button"
				onclick={() => (sort = 'name')}
				class={['font-medium hover:underline', sort === 'name' ? 'text-primary' : '']}
			>
				Name
			</button>
		</div>
	</div>

	<!-- Table of Cities -->
	<div class="overflow-hidden rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
		<div class="overflow-x-auto">
			<table class="w-full text-left text-sm">
				<thead class="border-b border-neutral-200 bg-neutral-50/50 text-xs font-medium text-neutral-500 dark:border-neutral-800 dark:bg-neutral-800/50 dark:text-neutral-400">
					<tr>
						<th class="px-4 py-3">City / Slug</th>
						<th class="px-4 py-3">Region</th>
						<th class="px-4 py-3 text-right">Population</th>
						<th class="px-4 py-3 text-center">Status</th>
						<th class="px-4 py-3 text-right">Enriched Areas</th>
						<th class="px-4 py-3 text-right">Actions</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-neutral-200 dark:divide-neutral-800">
					{#if filteredCities.length === 0}
						<tr>
							<td colspan="6" class="p-8 text-center text-neutral-500 dark:text-neutral-400">
								No cities match the active query or filter.
							</td>
						</tr>
					{:else}
						{#each filteredCities as c (c.slug)}
							<tr class="transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-800/50">
								<td class="px-4 py-3 font-medium text-neutral-900 dark:text-neutral-100">
									<div class="flex items-center gap-2">
										<a
											href={previewGuideHref(c.slug)}
											target="_blank"
											rel="noopener noreferrer"
											class="hover:underline hover:text-primary"
										>
											{c.name}
										</a>
										<span class="font-mono text-xs text-neutral-400">/{c.slug}</span>
									</div>
								</td>

								<td class="px-4 py-3 text-xs text-neutral-500 dark:text-neutral-400">
									{c.country || 'Global'} {#if c.continent}· {c.continent}{/if}
								</td>

								<td class="px-4 py-3 text-right font-mono text-xs text-neutral-600 dark:text-neutral-300">
									{c.pop ? c.pop.toLocaleString() : '—'}
								</td>

								<td class="px-4 py-3 text-center">
									{#if c.hasInfobox}
										<Badge variant="outline" class="border-emerald-500/30 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 font-mono text-[11px]">
											✓ Staged
										</Badge>
									{:else}
										<Badge variant="outline" class="border-amber-500/30 bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300 font-mono text-[11px]">
											Pending
										</Badge>
									{/if}
								</td>

								<td class="px-4 py-3 text-right">
									{#if c.neighborhoodsCount > 0}
										<span class="inline-flex items-center gap-1.5 font-mono text-xs font-semibold text-sky-600 dark:text-sky-400">
											{c.neighborhoodsCount} areas
										</span>
									{:else}
										<span class="font-mono text-xs text-neutral-400">0</span>
									{/if}
								</td>

								<td class="px-4 py-3 text-right">
									<div class="flex items-center justify-end gap-1.5">
										<button
											type="button"
											onclick={() => copyS3(c.slug)}
											class="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
											title="Copy S3 URI"
										>
											S3 URI
										</button>
										<a
											href={previewGuideHref(c.slug)}
											target="_blank"
											rel="noopener noreferrer"
											class="rounded px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10"
										>
											Preview ↗
										</a>
									</div>
								</td>
							</tr>
						{/each}
					{/if}
				</tbody>
			</table>
		</div>
	</div>
</div>
