<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import { Badge } from '$lib/components/ui/badge';

	let { data } = $props();

	type TypeDef = { key: string; label: string; suffix: string };

	type EnvCoverage = {
		ok: boolean;
		error: string | null;
		env: 'production' | 'preview';
		base: string;
		live: Record<string, { route: string }>;
		slugsByPrefix: Record<string, Record<string, string | null>>;
		pageOnly: { slug: string; route: string }[];
		pageOnlyCount: number;
		count: number;
		lastUpdated: { collections: string | null };
	};

	type City = {
		name: string;
		iata: string;
		continent: string;
		pop: number;
		prefix: string;
		attachedAddresses: number;
		attachedStreets: number;
		prodSlugs: Record<string, string | null> | null;
		prevSlugs: Record<string, string | null> | null;
	};

	const types = data.types as TypeDef[];
	const cities = data.cities as City[];
	const prod = data.production as EnvCoverage;
	const prev = data.preview as EnvCoverage;

	// ── Filters / sort ──
	let q = $state('');
	let hideComplete = $state(false);
	let onlyGaps = $state(false);
	let onlyNoPage = $state(false);
	let onlyBranchDiff = $state(false);
	let sort = $state('manifest');

	// ── Coverage state per cell (mirrors atlas/dashboard.html) ──
	type CellState = 'ok' | 'map' | 'nopage' | 'missing' | 'pageonly';

	function cellState(
		c: City,
		t: TypeDef,
		which: 'prod' | 'prev'
	): {
		s: CellState;
		slug: string | null;
		route: string | null;
	} {
		const coverage = which === 'prod' ? prod : prev;
		const slugs = (which === 'prod' ? c.prodSlugs : c.prevSlugs) ?? null;
		const slug = slugs?.[t.key] ?? null;
		const pageSlug = slug ?? `${c.prefix}-${t.suffix}`;
		const entry = coverage?.live?.[pageSlug];
		if (slug) {
			if (entry) return { s: entry.route === '/atlas/' ? 'ok' : 'map', slug, route: entry.route };
			return { s: 'nopage', slug, route: null };
		}
		if (entry) return { s: 'pageonly', slug: null, route: entry.route };
		return { s: 'missing', slug: null, route: null };
	}

	function haveOf(c: City, which: 'prod' | 'prev'): number {
		const slugs = (which === 'prod' ? c.prodSlugs : c.prevSlugs) ?? {};
		return types.filter((t) => slugs[t.key]).length;
	}

	function gapsOf(c: City): number {
		// A gap on either branch counts — surface incomplete rows regardless of branch.
		const pg = types.filter((t) => !(c.prodSlugs?.[t.key])).length;
		const vg = types.filter((t) => !(c.prevSlugs?.[t.key])).length;
		return Math.min(pg, vg);
	}

	function cellDiffers(c: City, t: TypeDef): boolean {
		return cellState(c, t, 'prod').s !== cellState(c, t, 'prev').s;
	}

	function rowDiffers(c: City): boolean {
		return types.some((t) => cellDiffers(c, t));
	}

	// ── Stats ──
	function statsFor(which: 'prod' | 'prev') {
		return types.map((t) => {
			const s = { json: 0, ok: 0, map: 0, nopage: 0, missing: 0, pageonly: 0 };
			for (const c of cities) {
				const st = cellState(c, t, which).s;
				s[st]++;
				const slugs = (which === 'prod' ? c.prodSlugs : c.prevSlugs) ?? {};
				if (slugs[t.key]) s.json++;
			}
			return s;
		});
	}

	const prodStats = $derived(statsFor('prod'));
	const prevStats = $derived(statsFor('prev'));

	function totalsOf(stats: ReturnType<typeof statsFor>) {
		return stats.reduce(
			(acc, s) => {
				for (const k in acc) acc[k as keyof typeof acc] += s[k as keyof typeof s];
				return acc;
			},
			{ json: 0, ok: 0, map: 0, nopage: 0, missing: 0, pageonly: 0 }
		);
	}

	const prodTotals = $derived(totalsOf(prodStats));
	const prevTotals = $derived(totalsOf(prevStats));

	const prodComplete = $derived(cities.filter((c) => haveOf(c, 'prod') === types.length).length);
	const prevComplete = $derived(cities.filter((c) => haveOf(c, 'prev') === types.length).length);
	const branchDiffRows = $derived(cities.filter(rowDiffers).length);

	const totalAttachedAddresses = $derived(
		cities.reduce((sum, c) => sum + (c.attachedAddresses || 0), 0)
	);
	const totalAttachedStreets = $derived(
		cities.reduce((sum, c) => sum + (c.attachedStreets || 0), 0)
	);

	// ── Visible rows ──
	const CONT_ORDER = ['Europe', 'Asia', 'North America', 'South America', 'Africa', 'Oceania'];
	const visible = $derived.by(() => {
		const query = q.trim().toLowerCase();
		let rows = cities.filter((c) => {
			if ((hideComplete || onlyGaps) && gapsOf(c) === 0) return false;
			if (onlyNoPage) {
				const any = types.some(
					(t) =>
						((c.prodSlugs?.[t.key] && cellState(c, t, 'prod').s === 'nopage') ||
							(c.prevSlugs?.[t.key] && cellState(c, t, 'prev').s === 'nopage')) as boolean
				);
				if (!any) return false;
			}
			if (onlyBranchDiff && !rowDiffers(c)) return false;
			if (
				query &&
				!(
					c.name.toLowerCase().includes(query) ||
					c.iata.toLowerCase().includes(query) ||
					c.prefix.toLowerCase().includes(query)
				)
			)
				return false;
			return true;
		});
		rows = [...rows];
		if (sort === 'name') rows.sort((a, b) => a.name.localeCompare(b.name));
		else if (sort === 'pop') rows.sort((a, b) => (b.pop || 0) - (a.pop || 0));
		else if (sort === 'addresses')
			rows.sort((a, b) => (b.attachedAddresses || 0) - (a.attachedAddresses || 0));
		else if (sort === 'streets')
			rows.sort((a, b) => (b.attachedStreets || 0) - (a.attachedStreets || 0));
		else if (sort === 'continent')
			rows.sort(
				(a, b) =>
					CONT_ORDER.indexOf(a.continent) - CONT_ORDER.indexOf(b.continent) ||
					a.name.localeCompare(b.name)
			);
		else if (sort === 'gaps')
			rows.sort((a, b) => gapsOf(b) - gapsOf(a) || a.name.localeCompare(b.name));
		else if (sort === 'diff')
			rows.sort((a, b) => Number(rowDiffers(b)) - Number(rowDiffers(a)) || a.name.localeCompare(b.name));
		return rows;
	});

	// ── Toast + click-through ──
	let toastMsg = $state('');
	let toastTimer: ReturnType<typeof setTimeout> | null = null;
	function showToast(msg: string) {
		toastMsg = msg;
		if (toastTimer) clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toastMsg = ''), 2200);
	}
	function openCell(d: { slug: string | null; route: string | null }, which: 'prod' | 'prev') {
		if (!d.slug || !d.route) return;
		const coverage = which === 'prod' ? prod : prev;
		const url = coverage.base + d.route + d.slug;
		if (navigator.clipboard) navigator.clipboard.writeText(url).catch(() => {});
		showToast(url + '  (copied)');
		window.open(url, '_blank');
	}

	function openPageOnly(p: { slug: string; route: string }, which: 'prod' | 'prev') {
		const coverage = which === 'prod' ? prod : prev;
		window.open(coverage.base + p.route + p.slug, '_blank');
	}

	function formatAgo(iso: string | null | undefined): string {
		if (!iso) return '';
		const d = new Date(iso);
		if (isNaN(d.getTime())) return '';
		const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
		return s < 90
			? `${s}s ago`
			: s < 3600
				? `${Math.floor(s / 60)}m ago`
				: s < 86400
					? `${Math.floor(s / 3600)}h ago`
					: `${Math.floor(s / 86400)}d ago`;
	}

	function formatDateTime(iso: string | null | undefined): string {
		if (!iso) return '';
		const d = new Date(iso);
		if (isNaN(d.getTime())) return '';
		return d.toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function stateLabel(st: ReturnType<typeof cellState>, whichLabel: string): string {
		if (st.s === 'ok' || st.s === 'map') return `${whichLabel}: ${st.slug}`;
		if (st.s === 'nopage') return `${whichLabel}: ${st.slug}  (no page under /atlas/ or /maps/)`;
		if (st.s === 'pageonly')
			return `${whichLabel}: ${st.route}${st.slug}  (page exists, not in manifest)`;
		return `${whichLabel}: MISSING from manifest`;
	}

	const lastUp = $derived(data.lastUpdated);
</script>

<svelte:head>
	<title>Atlas Coverage · Geo Admin · Cloudflarebase</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-full space-y-5 px-3 py-5 sm:px-6 sm:py-8">
	<div class="flex flex-wrap items-center justify-between gap-4">
		<div>
			<h1 class="text-2xl font-bold tracking-tight">Atlas Coverage</h1>
			<p class="mt-1 text-sm text-muted-foreground">
				{data.count} manifest cities &times; {types.length} atlas families — computed live from
				<span class="font-mono">/data/atlas-collections.json</span>
				<span class="font-mono">/api/map-index.json</span>. Each cell shows
				<span class="font-semibold text-sky-600">master</span> ·
				<span class="font-semibold text-violet-600">preview</span>
				(left → right). Click a cell to open (and copy) that branch’s page.
			</p>
			{#if lastUp}
				<div class="mt-2.5 flex flex-wrap items-center gap-2 text-xs">
					{#if lastUp.inProgress}
						<Badge variant="outline" class="border-amber-500/40 bg-amber-500/10 text-amber-500 font-medium">
							<span class="mr-1.5 inline-block size-1.5 rounded-full bg-amber-500 animate-pulse"></span>
							POI refresh in progress ({lastUp.progressCitiesDone ?? 0}/{lastUp.progressTotalCities ?? 500} cities · {formatAgo(lastUp.progressBatchAt)})
						</Badge>
					{:else if lastUp.poiLastRun}
						<Badge variant="outline" class="border-emerald-500/40 bg-emerald-500/10 text-emerald-500 font-medium">
							POI data updated: {formatDateTime(lastUp.poiLastRun)} ({formatAgo(lastUp.poiLastRun)})
						</Badge>
					{/if}
					{#if lastUp.registryGeneratedAt}
						<Badge variant="secondary" class="font-normal text-muted-foreground">
							Registry: {formatDateTime(lastUp.registryGeneratedAt)} ({formatAgo(lastUp.registryGeneratedAt)})
						</Badge>
					{/if}
					{#if lastUp.prodCollections}
						<Badge variant="secondary" class="font-normal text-muted-foreground">
							Master collections: {formatDateTime(lastUp.prodCollections)} ({formatAgo(lastUp.prodCollections)})
						</Badge>
					{/if}
					{#if lastUp.prevCollections}
						<Badge variant="secondary" class="font-normal text-muted-foreground">
							Preview collections: {formatDateTime(lastUp.prevCollections)} ({formatAgo(lastUp.prevCollections)})
						</Badge>
					{/if}
					<Badge variant="secondary" class="font-normal text-muted-foreground">
						Loaded: {formatAgo(data.loadedAt)}
					</Badge>
				</div>
			{/if}
		</div>
		<div class="flex flex-wrap items-center gap-2 text-xs">
			{#if prod.ok}
				<Badge variant="outline" class="border-sky-500/40 bg-sky-500/10 text-sky-600 font-medium">
					Master (production) · {prod.count} cities
				</Badge>
			{:else}
				<Badge variant="outline" class="border-rose-500/40 bg-rose-500/10 text-rose-500 font-medium">
					Master down: {prod.error}
				</Badge>
			{/if}
			{#if prev.ok}
				<Badge variant="outline" class="border-violet-500/40 bg-violet-500/10 text-violet-600 font-medium">
					Preview (CI) · {prev.count} cities
				</Badge>
			{:else}
				<Badge variant="outline" class="border-rose-500/40 bg-rose-500/10 text-rose-500 font-medium">
					Preview down: {prev.error}
				</Badge>
			{/if}
		</div>
	</div>

	<!-- ── Branch comparison cards ── -->
	<div class="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="ac-branch-cards">
		<div class="rounded-lg border border-sky-500/30 bg-card p-3">
			<h3 class="text-xs font-semibold text-sky-600">Master (production) — geo-astro-site</h3>
			<div class="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
				<span><b class="block text-lg font-bold text-foreground">{prod.count}</b>cities</span>
				<span><b class="block text-lg font-bold text-emerald-500">{prodComplete}</b>complete</span>
				<span><b class="block text-lg font-bold text-rose-500">{prodTotals.missing}</b>gaps</span>
				<span><b class="block text-lg font-bold text-amber-500">{prodTotals.nopage}</b>no page</span>
				<span><b class="block text-lg font-bold text-violet-500">{prod.pageOnlyCount}</b>page-only</span>
				<span><b class="block text-lg font-bold text-sky-500">{prodTotals.ok + prodTotals.map}</b>pages</span>
			</div>
		</div>
		<div class="rounded-lg border border-violet-500/30 bg-card p-3">
			<h3 class="text-xs font-semibold text-violet-600">Preview (CI) — preview-geo-astro-site</h3>
			<div class="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
				<span><b class="block text-lg font-bold text-foreground">{prev.count}</b>cities</span>
				<span><b class="block text-lg font-bold text-emerald-500">{prevComplete}</b>complete</span>
				<span><b class="block text-lg font-bold text-rose-500">{prevTotals.missing}</b>gaps</span>
				<span><b class="block text-lg font-bold text-amber-500">{prevTotals.nopage}</b>no page</span>
				<span><b class="block text-lg font-bold text-violet-500">{prev.pageOnlyCount}</b>page-only</span>
				<span><b class="block text-lg font-bold text-violet-500">{prevTotals.ok + prevTotals.map}</b>pages</span>
			</div>
		</div>
	</div>

	<!-- ── Stat cards ── -->
	<div
		class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8"
		data-testid="ac-overview-cards"
	>
		<div class="rounded-lg border bg-card p-3">
			<h3 class="text-xs font-semibold text-muted-foreground">Overview</h3>
			<div class="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
				<span><b class="block text-lg font-bold text-foreground">{cities.length}</b>cities</span>
				<span><b class="block text-lg font-bold text-foreground">{types.length}</b>types</span>
				<span><b class="block text-lg font-bold text-amber-500">{branchDiffRows}</b>branch diffs</span>
				<span
					><b class="block text-lg font-bold text-sky-500">{(totalAttachedAddresses / 1e6).toFixed(1)}M</b
					>addresses</span
				>
				<span
					><b class="block text-lg font-bold text-sky-500">{totalAttachedStreets.toLocaleString('en-US')}</b
					>streets</span
				>
			</div>
		</div>
		{#each types as t, i (t.key)}
			<div class="rounded-lg border bg-card p-3">
				<h3 class="text-xs font-semibold text-muted-foreground">{t.label}</h3>
				<div class="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
					<span class="text-sky-600"
						><b class="block text-sm font-bold text-sky-600">{prodStats[i].ok + prodStats[i].map}</b
						>master</span
					>
					<span class="text-violet-600"
						><b class="block text-sm font-bold text-violet-600">{prevStats[i].ok + prevStats[i].map}</b
						>preview</span
					>
					<span
						><b class="block text-sm font-bold text-rose-500">{prodStats[i].missing}</b
						>gaps m</span
					>
					<span
						><b class="block text-sm font-bold text-amber-500">{prodStats[i].nopage}</b
						>no page m</span
					>
				</div>
			</div>
		{/each}
	</div>

	<!-- ── Legend ── -->
	<div
		class="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground"
		data-testid="ac-legend"
	>
		<span class="font-semibold text-foreground">Cell pair: left master · right preview</span>
		<span class="inline-flex items-center gap-1.5"
			><span class="dot ok"></span> in manifest + /atlas/ page</span
		>
		<span class="inline-flex items-center gap-1.5"
			><span class="dot map"></span> in manifest + /maps/ page</span
		>
		<span class="inline-flex items-center gap-1.5"
			><span class="dot nopage"></span> in manifest, no page</span
		>
		<span class="inline-flex items-center gap-1.5"
			><span class="dot missing"></span> missing from manifest</span
		>
		<span class="inline-flex items-center gap-1.5"
			><span class="dot pageonly"></span> page exists, not in manifest</span
		>
		<span class="inline-flex items-center gap-1.5"
			><span class="dot pair-diff"></span> branches disagree</span
		>
	</div>

	<!-- ── Controls ── -->
	<div
		class="flex flex-wrap items-center gap-x-4 gap-y-2 border-y py-2.5"
		data-testid="ac-controls"
	>
		<Input type="text" bind:value={q} placeholder="Search city / IATA / prefix…" class="h-8 w-60" />
		<label
			class="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground select-none"
		>
			<Checkbox bind:checked={hideComplete} class="size-3.5" />
			hide complete rows
		</label>
		<label
			class="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground select-none"
		>
			<Checkbox bind:checked={onlyGaps} class="size-3.5" />
			only rows missing from manifest
		</label>
		<label
			class="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground select-none"
		>
			<Checkbox bind:checked={onlyNoPage} class="size-3.5" />
			only rows with pageless entries
		</label>
		<label
			class="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground select-none"
		>
			<Checkbox bind:checked={onlyBranchDiff} class="size-3.5" />
			only branch diffs
		</label>
		<NativeSelect bind:value={sort} class="h-8">
			<option value="manifest">Sort: manifest order</option>
			<option value="diff">Sort: branch diffs first</option>
			<option value="addresses">Sort: most attached addresses</option>
			<option value="streets">Sort: most attached streets</option>
			<option value="name">Sort: name A–Z</option>
			<option value="pop">Sort: population</option>
			<option value="continent">Sort: continent</option>
			<option value="gaps">Sort: most gaps first</option>
		</NativeSelect>
		<span class="ml-auto text-xs text-muted-foreground tabular-nums">
			Showing {visible.length} of {cities.length} cities
		</span>
	</div>

	<!-- ── Coverage matrix ── -->
	<div class="overflow-auto rounded-lg border" data-testid="ac-matrix">
		<table class="w-full min-w-max border-collapse">
			<thead>
				<tr class="bg-card text-xs text-muted-foreground">
					<th class="sticky top-0 z-10 border-b bg-card px-3 py-2 text-left">City</th>
					<th class="sticky top-0 z-10 border-b bg-card px-3 py-2 text-right">
						Attached Addresses
						<span class="mt-0.5 block text-[10px] font-normal text-muted-foreground not-italic">
							top 0.01% doors
						</span>
					</th>
					<th class="sticky top-0 z-10 border-b bg-card px-2 py-2 text-center">
						Have
						<span class="mt-0.5 block text-[10px] font-normal not-italic">
							<span class="text-sky-600">M</span> /
							<span class="text-violet-600">P</span>
						</span>
					</th>
					{#each types as t, i (t.key)}
						<th class="sticky top-0 z-10 border-b bg-card px-2 py-2 text-left">
							{t.label}
							<span class="mt-0.5 block text-[10px] font-normal text-muted-foreground not-italic">
								<span class="text-sky-600">{prodStats[i].ok + prodStats[i].map}</span> /
								<span class="text-violet-600">{prevStats[i].ok + prevStats[i].map}</span> ok ·
								<span class="text-rose-500">{prodStats[i].missing}</span> gaps
							</span>
						</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each visible as c (c.prefix)}
					{@const haveM = haveOf(c, 'prod')}
					{@const haveP = haveOf(c, 'prev')}
					{@const diff = rowDiffers(c)}
					<tr class="border-b border-border/60 last:border-0 hover:bg-accent/50">
						<td class="px-3 py-1.5 align-top">
							<span class="font-semibold">{c.name}</span>
							<span class="ml-1.5 text-[11px] text-sky-500">{c.iata}</span>
							{#if diff}
								<span
									class="ml-1 rounded bg-amber-500/15 px-1 text-[10px] font-semibold text-amber-600"
									title="Master and preview coverage disagree for this city">diff</span
								>
							{/if}
							<span class="block text-[11px] text-muted-foreground">
								{c.continent} · pop {(c.pop || 0).toLocaleString('en-US')}
							</span>
						</td>
						<td class="px-3 py-1.5 text-right font-mono text-xs tabular-nums align-top">
							{#if (c.attachedAddresses || 0) > 0}
								<span class="font-semibold text-emerald-500">
									{(c.attachedAddresses || 0).toLocaleString('en-US')}
								</span>
								<span class="block text-[10px] text-muted-foreground">
									{(c.attachedStreets || 0).toLocaleString('en-US')} {c.attachedStreets === 1 ? 'street' : 'streets'}
								</span>
							{:else}
								<span class="text-muted-foreground/40">—</span>
							{/if}
						</td>
						<td class="px-2 py-1.5 text-center">
							<span class="inline-flex items-baseline gap-0.5 text-[11px] font-semibold tabular-nums">
								<span class="text-sky-600">{haveM}/{types.length}</span>
								<span class="text-muted-foreground/50">·</span>
								<span class="text-violet-600">{haveP}/{types.length}</span>
							</span>
						</td>
						{#each types as t (t.key)}
							{@const stM = cellState(c, t, 'prod')}
							{@const stP = cellState(c, t, 'prev')}
							{@const disagree = stM.s !== stP.s}
							<td class="px-2 py-1.5 text-center">
								<span class="inline-flex items-center justify-center gap-0.5">
									<button
										type="button"
										class={['dot', 'prod-dot', stM.s, disagree ? 'ring-1 ring-amber-400' : '']}
										disabled={!stM.slug || !stM.route}
										title={stateLabel(stM, 'Master')}
										onclick={() => openCell({ slug: stM.slug, route: stM.route }, 'prod')}
									></button>
									<button
										type="button"
										class={['dot', 'prev-dot', stP.s, disagree ? 'ring-1 ring-amber-400' : '']}
										disabled={!stP.slug || !stP.route}
										title={stateLabel(stP, 'Preview')}
										onclick={() => openCell({ slug: stP.slug, route: stP.route }, 'prev')}
									></button>
								</span>
							</td>
						{/each}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<!-- ── Page-only (both branches) ── -->
	<div class="grid gap-4 pt-2 lg:grid-cols-2" data-testid="ac-pageonly">
		<div>
			<h2 class="mb-2 text-sm font-semibold">
				Master — pages not in manifest
				<Badge variant="outline" class="ml-1 align-middle border-sky-500/40 text-sky-600"
					>{prod.pageOnlyCount}</Badge
				>
			</h2>
			{#if prod.pageOnly.length}
				<div class="flex flex-wrap gap-2">
					{#each prod.pageOnly as p (`m-${p.slug}`)}
						<button
							type="button"
							class="rounded-md border border-sky-400/50 bg-card px-2.5 py-1 font-mono text-xs hover:border-sky-500"
							onclick={() => openPageOnly(p, 'prod')}
						>
							{p.slug}
							<span class="ml-1 text-[10px] text-muted-foreground">{p.route}</span>
						</button>
					{/each}
				</div>
			{:else}
				<p class="text-xs text-muted-foreground">
					Every family page found on master is in the manifest.
				</p>
			{/if}
		</div>
		<div>
			<h2 class="mb-2 text-sm font-semibold">
				Preview — pages not in manifest
				<Badge variant="outline" class="ml-1 align-middle border-violet-500/40 text-violet-600"
					>{prev.pageOnlyCount}</Badge
				>
			</h2>
			{#if prev.pageOnly.length}
				<div class="flex flex-wrap gap-2">
					{#each prev.pageOnly as p (`p-${p.slug}`)}
						<button
							type="button"
							class="rounded-md border border-violet-400/50 bg-card px-2.5 py-1 font-mono text-xs hover:border-violet-500"
							onclick={() => openPageOnly(p, 'prev')}
						>
							{p.slug}
							<span class="ml-1 text-[10px] text-muted-foreground">{p.route}</span>
						</button>
					{/each}
				</div>
			{:else}
				<p class="text-xs text-muted-foreground">
					Every family page found on preview is in the manifest.
				</p>
			{/if}
		</div>
	</div>

	<p class="text-[11px] text-muted-foreground">
		Coverage loaded at {new Date(data.loadedAt).toUTCString()} · equivalent to the standalone
		<span class="font-mono">atlas/dashboard.html</span> generated by
		<span class="font-mono">node atlas/generate-dashboard.cjs</span>
	</p>

	<!-- Toast -->
	<div
		class={[
			'fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-sky-500 bg-card px-4 py-2 text-sm shadow-lg transition-opacity duration-200',
			toastMsg ? 'opacity-100' : 'pointer-events-none opacity-0'
		]}
		role="status"
	>
		{toastMsg}
	</div>
</div>

<style>
	.dot {
		display: inline-block;
		width: 14px;
		height: 18px;
		border-radius: 5px;
		border: 1px solid;
		cursor: pointer;
	}
	.dot:disabled {
		opacity: 0.55;
		cursor: default;
	}
	.dot.ok {
		background: rgba(31, 122, 68, 0.85);
		border-color: #2e9e5b;
	}
	.dot.map {
		background: rgba(21, 94, 117, 0.85);
		border-color: #22a7c9;
	}
	.dot.nopage {
		background: rgba(138, 100, 20, 0.85);
		border-color: #c99a1f;
	}
	.dot.missing {
		background: rgba(61, 20, 28, 0.85);
		border-color: #b03248;
	}
	.dot.pageonly {
		background: rgba(58, 42, 99, 0.9);
		border-color: #7e5cd6;
	}
	.dot.prod-dot {
		box-shadow: inset 0 -3px 0 rgba(14, 116, 144, 0.55);
	}
	.dot.prev-dot {
		box-shadow: inset 0 -3px 0 rgba(124, 58, 237, 0.55);
	}
	.dot.pair-diff {
		width: 28px;
		background: repeating-linear-gradient(
			-45deg,
			rgba(31, 122, 68, 0.85) 0 7px,
			rgba(138, 100, 20, 0.85) 7px 14px
		);
		border-color: #c99a1f;
	}
</style>
