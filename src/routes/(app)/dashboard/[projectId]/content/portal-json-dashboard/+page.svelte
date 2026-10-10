<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { enhance } from '$app/forms';
	import type { PortalCategoryStorage, PortalStorageReport } from '$lib/server/portal-json-storage';

	let { data } = $props();

	const previewOrigin = 'https://preview-geo-astro-site.foodstarmelbourne.workers.dev';
	function previewPortalHref(catId: string, slug?: string): string {
		if (catId === 'fastfood' && slug) {
			const cleanSlug = slug.replace(/^\d+-/, '').replace(/-data$/, '');
			return `${previewOrigin}/portal/fastfood/${cleanSlug}`;
		}
		if (catId === 'retail' && slug) {
			const cleanSlug = slug.replace(/^\d+-/, '').replace(/-data$/, '');
			return `${previewOrigin}/portal/retail/${cleanSlug}`;
		}
		return `${previewOrigin}/portal/${catId}`;
	}

	const categories = $derived((data.categories || []) as PortalCategoryStorage[]);
	const report = $derived(data.report as PortalStorageReport);

	// State
	let q = $state('');
	let selectedCategoryTab = $state<string>('all');
	let onlyMissing = $state(false);
	let onlyComplete = $state(false);
	let sort = $state<'name' | 'files' | 'missing'>('files');
	let savingRegistry = $state(false);
	let toastMessage = $state<string | null>(null);

	function showToast(msg: string) {
		toastMessage = msg;
		setTimeout(() => {
			if (toastMessage === msg) toastMessage = null;
		}, 3000);
	}

	// Filtered list of items (categories and their subfolders/brands)
	type PortalItem = {
		categoryId: string;
		categoryName: string;
		name: string;
		type: 'category' | 'chain' | 'root-file';
		r2Path: string;
		expectedFiles: number;
		presentFiles: number;
		missingFiles: number;
		isComplete: boolean;
		previewHref: string;
	};

	const flattenedItems = $derived.by(() => {
		const items: PortalItem[] = [];

		for (const cat of categories) {
			// Add the category summary item
			items.push({
				categoryId: cat.id,
				categoryName: cat.name,
				name: `${cat.name} (All Datasets)`,
				type: 'category',
				r2Path: `portal/data/${cat.id}/`,
				expectedFiles: cat.totalFiles,
				presentFiles: cat.presentFilesCount,
				missingFiles: cat.missingFilesCount,
				isComplete: cat.isComplete,
				previewHref: previewPortalHref(cat.id)
			});

			// If subfolders exist (e.g. fastfood 1-mcdonalds-data), add them
			for (const sub of cat.subfolders || []) {
				items.push({
					categoryId: cat.id,
					categoryName: cat.name,
					name: sub.name,
					type: 'chain',
					r2Path: `portal/data/${cat.id}/${sub.path}/`,
					expectedFiles: sub.expectedFiles,
					presentFiles: sub.presentFiles,
					missingFiles: Math.max(0, sub.expectedFiles - sub.presentFiles),
					isComplete: sub.isComplete,
					previewHref: previewPortalHref(cat.id, sub.name)
				});
			}

			// Add individual root files for non-subfolder categories (e.g. airport-data.json)
			for (const rf of cat.rootFiles || []) {
				if (cat.subfoldersCount === 0) {
					items.push({
						categoryId: cat.id,
						categoryName: cat.name,
						name: rf.name,
						type: 'root-file',
						r2Path: `portal/data/${cat.id}/${rf.path}`,
						expectedFiles: 1,
						presentFiles: rf.present ? 1 : 0,
						missingFiles: rf.present ? 0 : 1,
						isComplete: rf.present,
						previewHref: previewPortalHref(cat.id)
					});
				}
			}
		}

		return items;
	});

	const filteredItems = $derived.by(() => {
		const query = q.trim().toLowerCase();

		let rows = flattenedItems.filter((item) => {
			if (selectedCategoryTab !== 'all' && item.categoryId !== selectedCategoryTab) {
				return false;
			}
			if (onlyMissing && item.isComplete) return false;
			if (onlyComplete && !item.isComplete) return false;

			if (query) {
				const matchName = item.name.toLowerCase().includes(query);
				const matchCat = item.categoryName.toLowerCase().includes(query);
				const matchPath = item.r2Path.toLowerCase().includes(query);
				if (!matchName && !matchCat && !matchPath) return false;
			}
			return true;
		});

		rows = [...rows];
		if (sort === 'name') {
			rows.sort((a, b) => a.name.localeCompare(b.name));
		} else if (sort === 'files') {
			rows.sort((a, b) => b.expectedFiles - a.expectedFiles || a.name.localeCompare(b.name));
		} else if (sort === 'missing') {
			rows.sort((a, b) => b.missingFiles - a.missingFiles || a.name.localeCompare(b.name));
		}

		return rows;
	});

	function copyS3(r2Path: string) {
		const uri = `s3://globe/${r2Path}`;
		if (navigator.clipboard) navigator.clipboard.writeText(uri).catch(() => {});
		showToast(`Copied ${uri}`);
	}

	function downloadRegistryJson() {
		const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(report, null, 2));
		const dl = document.createElement('a');
		dl.setAttribute('href', dataStr);
		dl.setAttribute('download', 'portal-json-registry.json');
		dl.click();
	}
</script>

<div class="space-y-6 p-4 max-w-7xl mx-auto">
	<!-- Toast -->
	{#if toastMessage}
		<div class="fixed bottom-4 right-4 z-50 rounded-md bg-foreground px-4 py-2.5 text-xs font-medium text-background shadow-lg transition-all animate-in fade-in slide-in-from-bottom-2">
			{toastMessage}
		</div>
	{/if}

	<!-- Header banner -->
	<div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between border-b border-border/60 pb-5">
		<div>
			<div class="flex items-center gap-2">
				<h1 class="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
					Global Portal JSON Architecture
				</h1>
				<Badge variant="outline" class="border-sky-500/40 bg-sky-500/10 text-sky-500 font-mono text-[11px]">
					12 Categories Schema
				</Badge>
				{#if report?.source}
					<Badge variant="outline" class="text-[10px] uppercase font-mono">
						{report.source}
					</Badge>
				{/if}
			</div>
			<p class="mt-1 text-xs text-muted-foreground sm:text-sm max-w-3xl">
				Tracking granular datasets across 12 global portal domains in Cloudflare R2 (globe/portal/data/). Powers 3D MapLibre globe coverage, brand footprint networks, and city POI store clusters.
			</p>
		</div>

		<div class="flex flex-wrap items-center gap-2">
			<Button
				variant="outline"
				size="sm"
				class="text-xs h-8 cursor-pointer"
				onclick={downloadRegistryJson}
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
						showToast('Registry saved to R2 globe bucket!');
					};
				}}
			>
				<Button
					type="submit"
					size="sm"
					class="text-xs h-8 cursor-pointer"
					disabled={savingRegistry}
				>
					{savingRegistry ? 'Saving...' : 'Save Registry to R2'}
				</Button>
			</form>
		</div>
	</div>

	<!-- Top Metric Cards Grid -->
	<div class="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
		<div class="rounded-lg border border-border bg-card p-3 shadow-xs">
			<div class="text-[11px] font-medium text-muted-foreground uppercase">Total Datasets</div>
			<div class="mt-1 text-xl font-bold text-foreground">
				{(report?.totals?.totalExpectedFiles || 38941).toLocaleString()}
			</div>
			<div class="mt-1 text-[10px] text-muted-foreground">across 12 categories</div>
		</div>

		<div class="rounded-lg border border-border bg-card p-3 shadow-xs">
			<div class="text-[11px] font-medium text-muted-foreground uppercase">R2 Present</div>
			<div class="mt-1 text-xl font-bold text-emerald-500">
				{(report?.totals?.totalPresentFiles || 0).toLocaleString()}
			</div>
			<div class="mt-1 text-[10px] text-emerald-500/80">staged in globe</div>
		</div>

		<div class="rounded-lg border border-border bg-card p-3 shadow-xs">
			<div class="text-[11px] font-medium text-muted-foreground uppercase">Missing Files</div>
			<div class="mt-1 text-xl font-bold text-rose-500">
				{(report?.totals?.totalMissingFiles || 0).toLocaleString()}
			</div>
			<div class="mt-1 text-[10px] text-rose-500/80">pending upload</div>
		</div>

		<div class="rounded-lg border border-border bg-card p-3 shadow-xs">
			<div class="text-[11px] font-medium text-muted-foreground uppercase">Fast Food</div>
			<div class="mt-1 text-xl font-bold text-lime-500">11,326</div>
			<div class="mt-1 text-[10px] text-muted-foreground">101 brand chains</div>
		</div>

		<div class="rounded-lg border border-border bg-card p-3 shadow-xs">
			<div class="text-[11px] font-medium text-muted-foreground uppercase">Retail Footprint</div>
			<div class="mt-1 text-xl font-bold text-sky-500">27,198</div>
			<div class="mt-1 text-[10px] text-muted-foreground">100 retail chains</div>
		</div>

		<div class="rounded-lg border border-border bg-card p-3 shadow-xs">
			<div class="text-[11px] font-medium text-muted-foreground uppercase">Infra & Civic</div>
			<div class="mt-1 text-xl font-bold text-amber-500">417</div>
			<div class="mt-1 text-[10px] text-muted-foreground">airports, ports, unis...</div>
		</div>
	</div>

	<!-- Category Filter Tabs -->
	<div class="flex flex-wrap items-center gap-1.5 border-b border-border/50 pb-2">
		<button
			type="button"
			class={[
				'rounded-md px-3 py-1.5 text-xs font-medium transition cursor-pointer',
				selectedCategoryTab === 'all'
					? 'bg-primary text-primary-foreground shadow-xs'
					: 'text-muted-foreground hover:bg-muted hover:text-foreground'
			]}
			onclick={() => selectedCategoryTab = 'all'}
		>
			All Domains (12)
		</button>
		{#each categories as cat (cat.id)}
			<button
				type="button"
				class={[
					'rounded-md px-2.5 py-1.5 text-xs font-medium transition cursor-pointer flex items-center gap-1.5',
					selectedCategoryTab === cat.id
						? 'bg-primary text-primary-foreground shadow-xs'
						: 'text-muted-foreground hover:bg-muted hover:text-foreground'
				]}
				onclick={() => selectedCategoryTab = cat.id}
			>
				<span>{cat.name}</span>
				<span class="rounded bg-background/20 px-1 py-0.2 text-[10px] font-mono">
					{cat.totalFiles}
				</span>
			</button>
		{/each}
	</div>

	<!-- Search & Table Controls -->
	<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between text-xs">
		<div class="flex flex-1 items-center gap-3 max-w-md">
			<Input
				type="search"
				placeholder="Search brand, category, R2 path..."
				bind:value={q}
				class="h-8 text-xs"
			/>
		</div>

		<div class="flex flex-wrap items-center gap-3">
			<label class="flex items-center gap-1.5 cursor-pointer select-none">
				<Checkbox bind:checked={onlyMissing} />
				<span class="text-muted-foreground">Missing only</span>
			</label>
			<label class="flex items-center gap-1.5 cursor-pointer select-none">
				<Checkbox bind:checked={onlyComplete} />
				<span class="text-muted-foreground">Complete only</span>
			</label>

			<div class="flex items-center gap-1 border-l border-border/60 pl-3">
				<span class="text-muted-foreground mr-1">Sort:</span>
				<button
					type="button"
					class={['px-2 py-1 rounded text-xs transition cursor-pointer', sort === 'files' ? 'bg-primary text-primary-foreground font-medium' : 'hover:bg-muted']}
					onclick={() => sort = 'files'}
				>
					Files
				</button>
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
					Missing
				</button>
				<span class="text-muted-foreground ml-2">({filteredItems.length} items)</span>
			</div>
		</div>
	</div>

	<!-- Data Table -->
	<div class="overflow-x-auto rounded-lg border border-border bg-card">
		<table class="w-full text-left text-xs">
			<thead class="border-b border-border bg-muted/40 font-medium text-muted-foreground">
				<tr>
					<th class="p-2.5 pl-3 min-w-[220px]">Dataset / Brand / Category</th>
					<th class="p-2.5 w-24">Domain</th>
					<th class="p-2.5 text-center w-24">Files</th>
					<th class="p-2.5 text-center w-28">Status</th>
					<th class="p-2.5 min-w-[280px]">R2 Prefix / Key</th>
					<th class="p-2.5 text-center w-20">Actions</th>
				</tr>
			</thead>
			<tbody class="divide-y divide-border/60">
				{#each filteredItems as item (item.r2Path)}
					<tr class="hover:bg-muted/30 transition-colors">
						<td class="p-2.5 pl-3">
							<div class="flex items-baseline gap-2">
								<a
									href={item.previewHref}
									target="_blank"
									rel="noopener"
									class="font-semibold text-foreground hover:text-sky-500 hover:underline"
									title="Preview on live site"
								>
									{item.name}
								</a>
								<a
									href={item.previewHref}
									target="_blank"
									rel="noopener"
									class="text-[10px] text-sky-500 hover:underline"
								>↗</a>
							</div>
							<div class="text-[10px] text-muted-foreground font-mono">
								{item.type === 'category' ? 'Top-level domain' : item.type === 'chain' ? 'Brand cluster folder' : 'Master catalog JSON'}
							</div>
						</td>

						<td class="p-2.5">
							<Badge variant="outline" class="text-[10px] capitalize font-mono">
								{item.categoryName}
							</Badge>
						</td>

						<td class="p-2.5 text-center font-mono">
							{item.expectedFiles.toLocaleString()}
						</td>

						<td class="p-2.5 text-center">
							{#if item.isComplete}
								<Badge variant="outline" class="border-emerald-500/40 bg-emerald-500/10 text-emerald-500 text-[10px]">
									✓ Complete
								</Badge>
							{:else if item.presentFiles > 0}
								<Badge variant="outline" class="border-amber-500/40 bg-amber-500/10 text-amber-500 text-[10px]">
									{item.presentFiles}/{item.expectedFiles}
								</Badge>
							{:else}
								<Badge variant="outline" class="border-rose-500/40 bg-rose-500/10 text-rose-500 text-[10px]">
									Missing
								</Badge>
							{/if}
						</td>

						<td class="p-2.5 font-mono text-[11px] text-muted-foreground truncate max-w-[320px]" title={item.r2Path}>
							{item.r2Path}
						</td>

						<td class="p-2.5 text-center">
							<button
								type="button"
								class="size-6 rounded bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground transition cursor-pointer inline-flex items-center justify-center text-[10px] font-mono"
								onclick={() => copyS3(item.r2Path)}
								title="Copy S3 URI (s3://globe/{item.r2Path})"
							>
								URI
							</button>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>
