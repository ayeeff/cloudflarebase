<script lang="ts">
	let { data } = $props();

	const dash = data.dash;
	const loadError: string | null = data.error;

	const siteOrigin = dash?.siteOrigin ?? 'https://geo-astro-site.foodstarmelbourne.workers.dev';
	// Provider order for the matrix columns (Mapillary primary, KartaView backup).
	const layers: { key: string; label: string; suffix: string }[] = dash?.layers ?? [];
	type CityMeta = { city?: string; country: string | null; rank?: number | null };
	const citiesMeta: Record<string, CityMeta> = dash?.cities ?? {};
	const files: { name: string; size: number; modified?: string }[] = dash?.files ?? [];
	const manifestGeneratedAt: string | null = dash?.manifestGeneratedAt ?? null;

	// ── build the city × provider matrix from the manifest file list ──
	type Cell = { size: number; sizeMB: number; url: string; name: string };
	type Row = {
		slug: string;
		city: string;
		country: string | null;
		rank: number | null;
		cells: Record<string, Cell | undefined>;
		have: number;
		total: number;
		order: number;
	};

	const rows = $derived.by<Row[]>(() => {
		const bySlug: Record<string, Row> = {};
		let order = 0;
		for (const f of files) {
			let slug = f.name;
			let layer = '';
			for (const l of layers) {
				if (f.name.endsWith(`-${l.suffix}`)) {
					slug = f.name.slice(0, -(l.suffix.length + 1));
					layer = l.key;
					break;
				}
			}
			if (!layer) continue; // not a street-view file
			const rec = (bySlug[slug] ??= {
				slug,
				city: '',
				country: null,
				rank: null,
				cells: {},
				have: 0,
				total: 0,
				order: order++
			});
			const sizeMB = f.size / 1048576;
			rec.cells[layer] = {
				size: f.size,
				sizeMB,
				name: f.name,
				url: `${siteOrigin}/basemaps/${f.name}.pmtiles`
			};
			rec.total += f.size;
		}
		for (const slug of Object.keys(bySlug)) {
			const rec = bySlug[slug];
			const m = citiesMeta[slug];
			rec.city = m?.city ?? slug.replace(/-/g, ' ');
			rec.country = m?.country ?? null;
			rec.rank = m?.rank ?? null;
			rec.have = Object.keys(rec.cells).length;
		}
		return Object.values(bySlug).sort((a, b) => a.city.localeCompare(b.city));
	});

	// ── filters + sorting ──
	let q = $state('');
	let onlyCovered = $state(true);
	let sort = $state('size');

	const visible = $derived.by(() => {
		const query = q.trim().toLowerCase();
		let list = rows.filter((r) => {
			if (onlyCovered && r.have === 0) return false;
			if (query) {
				const hay = `${r.city} ${r.slug} ${r.country ?? ''}`.toLowerCase();
				if (!hay.includes(query)) return false;
			}
			return true;
		});
		switch (sort) {
			case 'name':
				list = [...list].sort(
					(a, b) => a.city.localeCompare(b.city) || a.slug.localeCompare(b.slug)
				);
				break;
			case 'size':
				list = [...list].sort((a, b) => b.total - a.total || a.city.localeCompare(b.city));
				break;
			default:
				break;
		}
		return list;
	});

	// ── column + overview stats ──
	type ColStat = { present: number; bytes: number };
	const colStats = $derived.by<Record<string, ColStat>>(() => {
		const out: Record<string, ColStat> = {};
		for (const l of layers) {
			const s: ColStat = { present: 0, bytes: 0 };
			for (const r of rows) {
				const c = r.cells[l.key];
				if (c) {
					s.present++;
					s.bytes += c.size;
				}
			}
			out[l.key] = s;
		}
		return out;
	});

	const totalBytes = $derived(rows.reduce((acc, r) => acc + r.total, 0));
	const bothRows = $derived(rows.filter((r) => r.have === layers.length).length);
	const mapillaryRows = $derived(rows.filter((r) => r.cells.mapillary).length);
	const kartaviewRows = $derived(rows.filter((r) => r.cells.kartaview).length);

	function fmtBytes(n: number): string {
		if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
		if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
		if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
		return `${n} B`;
	}

	const PROVIDER_COLOR: Record<string, string> = {
		mapillary: '#05cb63',
		kartaview: '#22d3ee'
	};
	const providerColor = (key: string) => PROVIDER_COLOR[key] ?? '#4cc2ff';

	// click a cell → copy the /basemaps URL + open it
	let toastMsg = $state('');
	let toastOn = $state(false);
	let toastTimer: ReturnType<typeof setTimeout> | undefined;
	function showToast(msg: string) {
		toastMsg = msg;
		toastOn = true;
		if (toastTimer) clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toastOn = false), 1800);
	}
	function openCell(c: Cell) {
		if (navigator.clipboard) navigator.clipboard.writeText(c.url).catch(() => {});
		showToast(`${c.url}  (copied)`);
		window.open(c.url, '_blank');
	}
	const atlasHref = (slug: string) => `${siteOrigin}/atlas/${slug}-city-atlas`;
</script>

<svelte:head>
	<title>Street View · Geo Admin · Cloudflarebase</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-full space-y-6 px-3 py-5 sm:px-6 sm:py-8">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold tracking-tight">
				Street View Coverage (Mapillary + KartaView)
			</h1>
			<p class="text-sm text-muted-foreground">
				{mapillaryRows} Mapillary · {kartaviewRows} KartaView pmtiles staged in R2
				<code>globe/basemaps/</code>
				{#if manifestGeneratedAt}· manifest {manifestGeneratedAt.slice(0, 10)}{/if}
			</p>
		</div>
		<div class="flex items-center gap-2 text-xs text-muted-foreground">
			<span>source:</span>
			<a
				href="https://layers-worker.foodstarmelbourne.workers.dev/dashboard"
				target="_blank"
				rel="noopener"
				class="text-blue-500 hover:underline"
				data-testid="sv-dashboard-json-link">layers-worker /dashboard</a
			>
			<button
				class="rounded-md border px-2 py-1 text-xs transition-colors hover:bg-accent"
				onclick={() => location.reload()}
				data-testid="sv-refresh"
			>
				Refresh
			</button>
		</div>
	</div>

	{#if loadError}
		<div
			class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-3 text-sm text-destructive"
			data-testid="sv-error"
		>
			Could not load the street-view dashboard: <code>{loadError}</code>. The layers-worker
			(`layers-worker.foodstarmelbourne.workers.dev`) may not be deployed, or its GLOBE R2 binding
			is misconfigured.
		</div>
	{:else}
		<div class="pdash" data-testid="streetview-dashboard">
			<header>
				<h2>Mapillary + KartaView Coverage</h2>
				<div class="sub">
					9th city-view tab data ·
					<a href="{siteOrigin}/atlas" target="_blank" rel="noopener">/atlas</a> street tab ·
					attribution: Imagery ©
					<a href="https://www.mapillary.com" target="_blank" rel="noopener">Mapillary</a>
					(CC BY-SA) · ©
					<a href="https://www.kartaview.org" target="_blank" rel="noopener">KartaView</a>
					(CC BY-SA 4.0)
				</div>
			</header>

			<div class="cards">
				<div class="card">
					<h3>Overview</h3>
					<div class="nums">
						<span><b>{rows.length}</b>staged</span>
						<span><b>{bothRows}</b>both providers</span>
						<span class="p"><b>{fmtBytes(totalBytes)}</b>total</span>
					</div>
				</div>
				{#each layers as l (l.key)}
					<div class="card">
						<h3>{l.label}</h3>
						<div class="nums">
							<span><b>{colStats[l.key]?.present ?? 0}</b>cities</span>
							<span class="mm"><b>{fmtBytes(colStats[l.key]?.bytes ?? 0)}</b>bytes</span>
						</div>
					</div>
				{/each}
			</div>

			<div class="legend">
				{#each layers as l (l.key)}
					<span
						><span class="chip" style="background:{providerColor(l.key)}"></span>
						{l.label} (click = copy URL + open)</span
					>
				{/each}
				<span
					><span class="chip off"></span> not staged — extract with
					<code>node layer/extract-city-mapillary.mjs --slug …</code> +
					<code>…-kartaview.mjs</code></span
				>
			</div>

			<div class="controls">
				<input
					type="text"
					placeholder="Search city / slug / country…"
					bind:value={q}
					data-testid="sv-search"
				/>
				<label
					><input type="checkbox" bind:checked={onlyCovered} data-testid="sv-only-covered" /> only staged
					cities</label
				>
				<select bind:value={sort} data-testid="sv-sort" class="tbl-sel">
					<option value="size">Sort: total size</option>
					<option value="name">Sort: name A–Z</option>
				</select>
				<span class="count">Showing {visible.length} of {rows.length} staged cities</span>
			</div>

			<div class="wrap">
				<table>
					<thead>
						<tr>
							<th>City</th>
							<th>Have</th>
							{#each layers as l (l.key)}
								<th>
									{l.label}
									<span class="thc">
										<i style="color:{providerColor(l.key)}">{colStats[l.key]?.present ?? 0}</i>
										staged ·
										{fmtBytes(colStats[l.key]?.bytes ?? 0)}</span
									>
								</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each visible as r (r.slug)}
							<tr>
								<td class="citycell">
									<!-- eslint-disable svelte/no-navigation-without-resolve -- cross-origin links to the geo site -->
									<a href={atlasHref(r.slug)} target="_blank" rel="noopener" class="citylink"
										><b>{r.city}</b></a
									>
									<span class="meta">{r.slug}</span>
									<span class="cont">
										{r.country ?? '—'}
										{#if r.rank}· rank {r.rank}{/if}
										·
										<a href="{atlasHref(r.slug)}#street" target="_blank" rel="noopener"
											>street tab ↗</a
										></span
									>
									<!-- eslint-enable svelte/no-navigation-without-resolve -->
								</td>
								<td>
									<span
										class={['badge', r.have === layers.length ? 'all' : r.have === 1 ? 'low' : '']}
									>
										{r.have}/{layers.length}
									</span>
								</td>
								{#each layers as l (r.slug + l.key)}
									{@const c = r.cells[l.key]}
									<td class="cell">
										{#if c}
											<button
												class="dot ok"
												style="background:{providerColor(l.key)}"
												title="{c.name} · {c.sizeMB.toFixed(1)} MB"
												onclick={() => openCell(c)}
												data-testid="cell-{r.slug}-{l.key}"
											></button>
										{:else}
											<button
												class="dot missing"
												title="NOT STAGED · {l.label}"
												onclick={() =>
													showToast(`no ${siteOrigin}/basemaps/${r.slug}-${l.suffix}.pmtiles`)}
												data-testid="cell-{r.slug}-{l.key}"
											></button>
										{/if}
									</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			<div class="foot">
				<span class="flabel">
					Interactive lookups: <code>{siteOrigin}/api/streetview-nearby.json?lat&lng&radius</code>
					(KartaView photos near a point) ·
					<code>{siteOrigin}/api/streetview-thumb?id=&lt;mapillary image id&gt;</code>
					(photo thumbnail proxy)
				</span>
			</div>
		</div>

		<div class={['toast', toastOn && 'show']}>{toastMsg}</div>
	{/if}
</div>

<style>
	/* Same self-contained dark coverage matrix as the pmtiles dashboard. */
	.pdash {
		--bg: #0b0f14;
		--panel: #111823;
		--panel2: #0e141d;
		--border: #1f2a38;
		--text: #dbe4ee;
		--muted: #7d8b9d;
		--accent: #4cc2ff;
		--missing: #3d141c;
		--missing-border: #b03248;
		background: var(--bg);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 18px 20px 20px;
		font:
			14px/1.45 'Segoe UI',
			system-ui,
			sans-serif;
	}
	.pdash header {
		padding: 0 0 10px;
	}
	.pdash header h2 {
		margin: 0 0 4px;
		font-size: 17px;
	}
	.pdash .sub {
		color: var(--muted);
		font-size: 12px;
	}
	.pdash .sub a {
		color: var(--accent);
		text-decoration: none;
	}
	.pdash .cards {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
		gap: 10px;
		margin: 14px 0;
	}
	.pdash .card {
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 10px 12px;
	}
	.pdash .card h3 {
		margin: 0 0 6px;
		font-size: 13px;
		font-weight: 600;
	}
	.pdash .card .nums {
		display: flex;
		gap: 12px;
		font-size: 12px;
		color: var(--muted);
	}
	.pdash .card .nums b {
		display: block;
		font-size: 16px;
		color: var(--text);
		font-weight: 600;
	}
	.pdash .card .nums .mm b {
		color: #4dd0f0;
	}
	.pdash .card .nums .p b {
		color: #b79bff;
	}
	.pdash .legend {
		display: flex;
		flex-wrap: wrap;
		gap: 14px;
		margin: 8px 0 14px;
		font-size: 12px;
		color: var(--muted);
	}
	.pdash .legend span {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.pdash .chip {
		width: 14px;
		height: 14px;
		border-radius: 4px;
		display: inline-block;
		border: 1px solid rgba(255, 255, 255, 0.25);
	}
	.pdash .chip.off {
		background: var(--missing);
		border-color: var(--missing-border);
	}
	.pdash .controls {
		position: sticky;
		top: 0;
		z-index: 20;
		background: var(--bg);
		padding: 10px 0;
		display: flex;
		flex-wrap: wrap;
		gap: 14px;
		align-items: center;
		border-bottom: 1px solid var(--border);
		margin-bottom: 10px;
	}
	.pdash .controls input[type='text'] {
		background: var(--panel2);
		border: 1px solid var(--border);
		color: var(--text);
		border-radius: 8px;
		padding: 7px 12px;
		width: 240px;
		font-size: 13px;
	}
	.pdash .controls input[type='text']:focus {
		outline: none;
		border-color: var(--accent);
	}
	.pdash .controls label {
		font-size: 12.5px;
		color: var(--muted);
		display: inline-flex;
		align-items: center;
		gap: 6px;
		cursor: pointer;
		user-select: none;
	}
	.pdash .controls label input {
		accent-color: var(--accent);
	}
	.pdash .tbl-sel {
		background: var(--panel2);
		border: 1px solid var(--border);
		color: var(--text);
		border-radius: 8px;
		padding: 6px 8px;
		font-size: 13px;
	}
	.pdash .count {
		font-size: 12px;
		color: var(--muted);
		margin-left: auto;
	}
	.pdash .wrap {
		overflow-x: auto;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--panel);
	}
	.pdash table {
		border-collapse: collapse;
		width: 100%;
	}
	.pdash thead th {
		position: sticky;
		top: 47px;
		background: var(--panel2);
		font-size: 11.5px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--muted);
		padding: 8px 10px;
		text-align: left;
		border-bottom: 1px solid var(--border);
		white-space: nowrap;
		z-index: 5;
	}
	.pdash thead th .thc {
		display: block;
		font-size: 10.5px;
		font-weight: 400;
		text-transform: none;
		letter-spacing: 0;
		margin-top: 2px;
	}
	.pdash thead th .thc i {
		font-style: normal;
	}
	.pdash tbody td {
		padding: 5px 10px;
		border-bottom: 1px solid #16202c;
	}
	.pdash tbody tr:hover {
		background: #141d29;
	}
	.pdash .citycell b {
		font-weight: 600;
	}
	.pdash .citycell .citylink {
		color: var(--text);
		text-decoration: none;
	}
	.pdash .citycell .citylink:hover {
		color: var(--accent);
		text-decoration: underline;
	}
	.pdash .citycell .meta {
		color: var(--accent);
		font-size: 11px;
		margin-left: 6px;
	}
	.pdash .citycell .cont {
		display: block;
		color: var(--muted);
		font-size: 11px;
	}
	.pdash .citycell .cont a {
		color: var(--muted);
		text-decoration: none;
	}
	.pdash .citycell .cont a:hover {
		color: var(--accent);
	}
	.pdash td.cell {
		text-align: center;
	}
	.pdash .dot {
		display: inline-block;
		width: 30px;
		height: 20px;
		border-radius: 5px;
		border: 1px solid;
		cursor: pointer;
		padding: 0;
	}
	.pdash .dot.ok {
		border-color: rgba(255, 255, 255, 0.35);
	}
	.pdash .dot.missing {
		background: var(--missing);
		border-color: var(--missing-border);
	}
	.pdash .badge {
		display: inline-block;
		min-width: 34px;
		text-align: center;
		font-size: 11px;
		padding: 2px 6px;
		border-radius: 999px;
		background: var(--panel2);
		border: 1px solid var(--border);
		color: var(--muted);
	}
	.pdash .badge.all {
		color: #6fe3a1;
		border-color: #2e9e5b;
	}
	.pdash .badge.low {
		color: #ffd48a;
		border-color: #b08a3e;
	}
	.pdash .foot {
		margin-top: 12px;
		font-size: 11.5px;
		color: var(--muted);
	}
	.pdash .foot code {
		background: var(--panel2);
		border: 1px solid var(--border);
		border-radius: 5px;
		padding: 0 5px;
		font-size: 10.5px;
	}
	.toast {
		position: fixed;
		bottom: 18px;
		left: 50%;
		transform: translateX(-50%);
		background: var(--panel, #111823);
		border: 1px solid var(--accent, #4cc2ff);
		color: #dbe4ee;
		border-radius: 8px;
		padding: 8px 16px;
		font-size: 13px;
		opacity: 0;
		pointer-events: none;
		transition:
			opacity 0.2s,
			transform 0.2s;
		z-index: 999;
	}
	.toast.show {
		opacity: 1;
	}
</style>
