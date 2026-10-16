<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { enhance } from '$app/forms';

	let { data } = $props();

	const previewOrigin = 'https://preview-geo-astro-site.foodstarmelbourne.workers.dev';

	const report = $derived(data.report);
	const layers = data.layers;
	const cities = $derived(report.cities || []);

	// State
	let q = $state('');
	let selectedLayer = $state<string>('all');
	let onlyMissing = $state(false);
	let onlyComplete = $state(false);
	let sort = $state<'name' | 'missing' | 'pop'>('pop');
	let savingRegistry = $state(false);
	let toastMessage = $state<string | null>(null);

	function showToast(msg: string) {
		toastMessage = msg;
		setTimeout(() => {
			if (toastMessage === msg) toastMessage = null;
		}, 3000);
	}

	const filteredCities = $derived.by(() => {
		const query = q.trim().toLowerCase();
		let rows = cities.filter((c: any) => {
			if (onlyMissing && c.presentCount === layers.length) return false;
			if (onlyComplete && c.presentCount < layers.length) return false;
			if (selectedLayer !== 'all' && !c.layers[selectedLayer]?.present) return false;
			if (query) {
				const matchName = c.name.toLowerCase().includes(query);
				const matchSlug = c.slug.toLowerCase().includes(query);
				const matchCountry = (c.country || '').toLowerCase().includes(query);
				if (!matchName && !matchSlug && !matchCountry) return false;
			}
			return true;
		});

		if (sort === 'pop') {
			rows.sort((a: any, b: any) => (b.pop || 0) - (a.pop || 0));
		} else if (sort === 'name') {
			rows.sort((a: any, b: any) => a.name.localeCompare(b.name));
		} else if (sort === 'missing') {
			rows.sort((a: any, b: any) => b.missingCount - a.missingCount);
		}

		return rows;
	});
</script>

<div class="space-y-6 p-6">
	<!-- Header -->
	<div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
		<div>
			<div class="flex items-center gap-3">
				<h1 class="text-2xl font-bold tracking-tight">Layer JSON Architecture</h1>
				<Badge variant="outline" class="font-mono text-xs">R2 globe/data/&lt;slug&gt;-2d/*.json</Badge>
			</div>
			<p class="text-muted-foreground mt-1 text-sm">
				Real-time monitoring of all 8 extracted thematic layer JSON files across {report.totalCities} global cities in R2.
			</p>
		</div>

		<div class="flex items-center gap-3">
			<form
				method="POST"
				action="?/saveRegistry"
				use:enhance={() => {
					savingRegistry = true;
					return async ({ result }) => {
						savingRegistry = false;
						if (result.type === 'success') {
							showToast('Saved layer JSON registry to R2!');
						} else {
							showToast('Failed to save registry');
						}
					};
				}}
			>
				<Button type="submit" variant="default" size="sm" disabled={savingRegistry}>
					{savingRegistry ? 'Saving...' : 'Save Registry to R2'}
				</Button>
			</form>
		</div>
	</div>

	{#if toastMessage}
		<div class="rounded-md bg-primary/10 border border-primary/20 px-4 py-2 text-sm text-primary font-medium">
			{toastMessage}
		</div>
	{/if}

	<!-- Layer Metric Cards -->
	<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-8">
		{#each layers as l}
			{@const stat = report.summary[l.id] || { present: 0, missing: 0 }}
			{@const pct = Math.round((stat.present / (report.totalCities || 1)) * 100)}
			<div
				class="rounded-xl border bg-card p-4 text-card-foreground shadow-sm cursor-pointer transition-all hover:border-primary/50"
				class:ring-2={selectedLayer === l.id}
				class:ring-primary={selectedLayer === l.id}
				onclick={() => { selectedLayer = selectedLayer === l.id ? 'all' : l.id; }}
			>
				<div class="flex items-center justify-between">
					<span class="text-xs font-semibold uppercase tracking-wider text-muted-foreground truncate" title={l.name}>{l.name}</span>
					<span class="h-2.5 w-2.5 rounded-full flex-none" style="background-color: {l.accent};"></span>
				</div>
				<div class="mt-2 text-2xl font-bold">{stat.present}</div>
				<div class="mt-1 flex items-center justify-between text-xs text-muted-foreground">
					<span class="truncate">{l.file}</span>
					<span class="font-medium text-foreground">{pct}%</span>
				</div>
				<div class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
					<div class="h-full rounded-full" style="width: {pct}%; background-color: {l.accent};"></div>
				</div>
			</div>
		{/each}
	</div>

	<!-- Controls & Search -->
	<div class="flex flex-col gap-3 rounded-lg border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
		<div class="flex flex-1 items-center gap-3 flex-wrap">
			<Input
				type="search"
				placeholder="Search by city, slug, or country..."
				bind:value={q}
				class="max-w-xs"
			/>
			<div class="flex items-center gap-2 flex-wrap">
				<Button
					variant={selectedLayer === 'all' ? 'secondary' : 'ghost'}
					size="sm"
					onclick={() => { selectedLayer = 'all'; }}
				>
					All Layers
				</Button>
				{#each layers as l}
					<Button
						variant={selectedLayer === l.id ? 'secondary' : 'ghost'}
						size="sm"
						onclick={() => { selectedLayer = l.id; }}
					>
						{l.name.split(' ')[0]}
					</Button>
				{/each}
			</div>
		</div>

		<div class="flex items-center gap-3 text-sm flex-wrap">
			<label class="flex items-center gap-2 text-muted-foreground cursor-pointer">
				<input type="checkbox" bind:checked={onlyComplete} onchange={() => { if (onlyComplete) onlyMissing = false; }} />
				Only Complete (8/8)
			</label>
			<label class="flex items-center gap-2 text-muted-foreground cursor-pointer">
				<input type="checkbox" bind:checked={onlyMissing} onchange={() => { if (onlyMissing) onlyComplete = false; }} />
				Has Missing (&lt;8)
			</label>
			<div class="h-4 w-px bg-border"></div>
			<div class="flex items-center gap-1.5 text-xs text-muted-foreground">
				<span>Sort:</span>
				<button class="font-medium text-foreground hover:underline" onclick={() => { sort = 'pop'; }}>Pop</button>
				<span>&middot;</span>
				<button class="font-medium text-foreground hover:underline" onclick={() => { sort = 'name'; }}>Name</button>
				<span>&middot;</span>
				<button class="font-medium text-foreground hover:underline" onclick={() => { sort = 'missing'; }}>Missing</button>
			</div>
		</div>
	</div>

	<!-- Table -->
	<div class="rounded-lg border bg-card shadow-sm overflow-hidden">
		<div class="overflow-x-auto">
			<table class="w-full text-left text-sm">
				<thead class="border-b bg-muted/40 text-xs font-semibold uppercase text-muted-foreground">
					<tr>
						<th class="px-4 py-3">City & Country</th>
						<th class="px-4 py-3">Population</th>
						{#each layers as l}
							<th class="px-3 py-3 text-center">{l.name}</th>
						{/each}
						<th class="px-4 py-3 text-center">Score</th>
						<th class="px-4 py-3 text-right">Atlas Link</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-border font-mono text-xs">
					{#each filteredCities as city}
						<tr class="hover:bg-muted/30 transition-colors">
							<td class="px-4 py-3">
								<div class="font-sans font-semibold text-foreground text-sm">{city.name}</div>
								<div class="text-muted-foreground">{city.slug} &middot; {city.country}</div>
							</td>
							<td class="px-4 py-3 font-sans text-muted-foreground">
								{city.pop ? Number(city.pop).toLocaleString() : '—'}
							</td>
							{#each layers as l}
								{@const pres = city.layers[l.id]?.present}
								<td class="px-3 py-3 text-center">
									{#if pres}
										<span class="inline-flex items-center justify-center rounded px-2 py-0.5 text-[11px] font-semibold bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
											✓ {l.file.split('.')[0]}
										</span>
									{:else}
										<span class="inline-flex items-center justify-center rounded px-2 py-0.5 text-[11px] font-semibold bg-red-500/10 text-red-500 border border-red-500/20">
											✗
										</span>
									{/if}
								</td>
							{/each}
							<td class="px-4 py-3 text-center font-sans">
								{#if city.isComplete}
									<Badge variant="default" class="bg-emerald-600">{layers.length} / {layers.length}</Badge>
								{:else if city.presentCount >= Math.ceil(layers.length / 2)}
									<Badge variant="secondary">{city.presentCount} / {layers.length}</Badge>
								{:else}
									<Badge variant="destructive">{city.presentCount} / {layers.length}</Badge>
								{/if}
							</td>
							<td class="px-4 py-3 text-right font-sans">
								<a
									href="{previewOrigin}/atlas/{city.slug}-city-atlas"
									target="_blank"
									rel="noreferrer"
									class="inline-flex items-center gap-1 text-xs text-primary hover:underline"
								>
									Atlas ↗
								</a>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
</div>
