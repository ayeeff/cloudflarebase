<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import { Badge } from '$lib/components/ui/badge';

	let { data } = $props();

	const base = data.base ?? 'https://geo-astro-site.foodstarmelbourne.workers.dev';

	type TypeDef = { key: string; label: string; suffix: string };
	type City = {
		name: string;
		iata: string;
		continent: string;
		pop: number;
		prefix: string;
		slugs: Record<string, string | null>;
	};

	const types = data.types as TypeDef[];
	const cities = data.cities as City[];
	const live = (data.live ?? {}) as Record<string, { route: string }>;
	const pageOnly = data.pageOnly as { slug: string; route: string }[];

	// ── Filters / sort ──
	let q = $state('');
	let hideComplete = $state(false);
	let onlyGaps = $state(false);
	let onlyNoPage = $state(false);
	let sort = $state('manifest');

	// ── Coverage state per cell (mirrors atlas/dashboard.html) ──
	type CellState = 'ok' | 'map' | 'nopage' | 'missing' | 'pageonly';

	function cellState(
		c: City,
		t: TypeDef
	): {
		s: CellState;
		slug: string | null;
		route: string | null;
	} {
		const slug = c.slugs?.[t.key] ?? null;
		const pageSlug = slug ?? `${c.prefix}-${t.suffix}`;
		const entry = live[pageSlug];
		if (slug) {
			if (entry) return { s: entry.route === '/atlas/' ? 'ok' : 'map', slug, route: entry.route };
			return { s: 'nopage', slug, route: null };
		}
		if (entry) return { s: 'pageonly', slug: null, route: entry.route };
		return { s: 'missing', slug: null, route: null };
	}

	const gapsOf = (c: City) => types.filter((t) => !c.slugs?.[t.key]).length;
	const haveOf = (c: City) => types.length - gapsOf(c);

	// ── Stats ──
	const stats = $derived(
		types.map((t) => {
			const s = { json: 0, ok: 0, map: 0, nopage: 0, missing: 0, pageonly: 0 };
			for (const c of cities) {
				const st = cellState(c, t).s;
				s[st]++;
				if (c.slugs?.[t.key]) s.json++;
			}
			return s;
		})
	);
	const totals = $derived(
		stats.reduce(
			(acc, s) => {
				for (const k in acc) acc[k as keyof typeof acc] += s[k as keyof typeof s];
				return acc;
			},
			{ json: 0, ok: 0, map: 0, nopage: 0, missing: 0, pageonly: 0 }
		)
	);
	const completeRows = $derived(cities.filter((c) => gapsOf(c) === 0).length);

	// ── Visible rows ──
	const CONT_ORDER = ['Europe', 'Asia', 'North America', 'South America', 'Africa', 'Oceania'];
	const visible = $derived.by(() => {
		const query = q.trim().toLowerCase();
		let rows = cities.filter((c) => {
			if ((hideComplete || onlyGaps) && gapsOf(c) === 0) return false;
			if (onlyNoPage) {
				const any = types.some((t) => c.slugs?.[t.key] && cellState(c, t).s === 'nopage');
				if (!any) return false;
			}
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
		else if (sort === 'continent')
			rows.sort(
				(a, b) =>
					CONT_ORDER.indexOf(a.continent) - CONT_ORDER.indexOf(b.continent) ||
					a.name.localeCompare(b.name)
			);
		else if (sort === 'gaps')
			rows.sort((a, b) => gapsOf(b) - gapsOf(a) || a.name.localeCompare(b.name));
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
	function openCell(d: { slug: string | null; route: string | null }) {
		if (!d.slug || !d.route) return;
		const url = base + d.route + d.slug;
		if (navigator.clipboard) navigator.clipboard.writeText(url).catch(() => {});
		showToast(url + '  (copied)');
		window.open(url, '_blank');
	}
</script>

<svelte:head>
	<title>Atlas Coverage · Geo Admin · Cloudflarebase</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-full space-y-5 px-3 py-5 sm:px-6 sm:py-8">
	<div>
		<h1 class="text-2xl font-bold tracking-tight">Atlas Coverage</h1>
		<p class="mt-1 text-sm text-muted-foreground">
			{data.count} manifest cities &times; {types.length} atlas families — computed live from
			<span class="font-mono">/data/atlas-collections.json</span>
			<span class="font-mono">/api/map-index.json</span>. Click a cell to open (and copy) the page.
		</p>
	</div>

	<!-- ── Stat cards ── -->
	<div
		class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7"
		data-testid="ac-overview-cards"
	>
		<div class="rounded-lg border bg-card p-3">
			<h3 class="text-xs font-semibold text-muted-foreground">Overview</h3>
			<div class="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
				<span><b class="block text-lg font-bold text-foreground">{cities.length}</b>cities</span>
				<span><b class="block text-lg font-bold text-foreground">{types.length}</b>types</span>
				<span><b class="block text-lg font-bold text-emerald-500">{completeRows}</b>complete</span>
				<span><b class="block text-lg font-bold text-rose-500">{totals.missing}</b>gaps</span>
				<span><b class="block text-lg font-bold text-amber-500">{totals.nopage}</b>no page</span>
				<span
					><b class="block text-lg font-bold text-violet-500">{pageOnly.length}</b>page-only</span
				>
			</div>
		</div>
		{#each types as t, i (t.key)}
			<div class="rounded-lg border bg-card p-3">
				<h3 class="text-xs font-semibold text-muted-foreground">{t.label}</h3>
				<div class="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
					<span><b class="block text-lg font-bold text-foreground">{stats[i].json}</b>manifest</span
					>
					<span><b class="block text-lg font-bold text-rose-500">{stats[i].missing}</b>gaps</span>
					<span><b class="block text-lg font-bold text-amber-500">{stats[i].nopage}</b>no page</span
					>
					<span
						><b class="block text-lg font-bold text-sky-500">{stats[i].ok + stats[i].map}</b
						>pages</span
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
		<NativeSelect bind:value={sort} class="h-8">
			<option value="manifest">Sort: manifest order</option>
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
					<th class="sticky top-0 z-10 border-b bg-card px-2 py-2 text-left">Have</th>
					{#each types as t, i (t.key)}
						<th class="sticky top-0 z-10 border-b bg-card px-2 py-2 text-left">
							{t.label}
							<span class="mt-0.5 block text-[10px] font-normal text-muted-foreground not-italic">
								<span class="text-emerald-500">{stats[i].ok + stats[i].map}</span> ok ·
								<span class="text-rose-500">{stats[i].missing}</span> gaps ·
								<span class="text-amber-500">{stats[i].nopage}</span> no page
							</span>
						</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each visible as c (c.name + c.iata)}
					{@const have = haveOf(c)}
					<tr class="border-b border-border/60 last:border-0 hover:bg-accent/50">
						<td class="px-3 py-1.5 align-top">
							<span class="font-semibold">{c.name}</span>
							<span class="ml-1.5 text-[11px] text-sky-500">{c.iata}</span>
							<span class="block text-[11px] text-muted-foreground">
								{c.continent} · pop {(c.pop || 0).toLocaleString('en-US')}
							</span>
						</td>
						<td class="px-2 py-1.5 text-center">
							<Badge
								variant={have === types.length
									? 'default'
									: have <= 2
										? 'destructive'
										: 'secondary'}
								class="min-w-9 justify-center text-[11px]">{have}/{types.length}</Badge
							>
						</td>
						{#each types as t (t.key)}
							{@const st = cellState(c, t)}
							<td class="px-2 py-1.5 text-center">
								<button
									type="button"
									class={['dot', st.s]}
									disabled={!st.slug || !st.route}
									title={st.s === 'ok' || st.s === 'map'
										? st.slug
										: st.s === 'nopage'
											? `${st.slug}  (no page under /atlas/ or /maps/)`
											: st.s === 'pageonly'
												? `${st.route}${st.slug}  (page exists, not in manifest)`
												: `MISSING from manifest — expected: ${c.prefix}-${t.suffix}`}
									onclick={() => openCell({ slug: st.slug, route: st.route })}
								></button>
							</td>
						{/each}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<!-- ── Page-only ── -->
	<div class="pt-2" data-testid="ac-pageonly">
		<h2 class="mb-2 text-sm font-semibold">
			Pages on disk but not in manifest
			<Badge variant="outline" class="ml-1 align-middle">{pageOnly.length}</Badge>
		</h2>
		{#if pageOnly.length}
			<div class="flex flex-wrap gap-2">
				<!-- eslint-disable svelte/no-navigation-without-resolve -- external absolute URL on geo-astro-site, not a local route -->
				{#each pageOnly as p (p.slug)}
					<a
						href={base + p.route + p.slug}
						target="_blank"
						rel="noopener"
						class="rounded-md border border-violet-400/50 bg-card px-2.5 py-1 font-mono text-xs hover:border-sky-500"
					>
						{p.slug}
						<span class="ml-1 text-[10px] text-muted-foreground">{p.route}</span>
					</a>
				{/each}
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
			</div>
		{:else}
			<p class="text-xs text-muted-foreground">
				Every family page found on the site is in the manifest.
			</p>
		{/if}
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
		width: 28px;
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
</style>
