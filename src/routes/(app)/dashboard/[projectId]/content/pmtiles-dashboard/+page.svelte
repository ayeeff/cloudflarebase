<script lang="ts">
	let { data } = $props();

	const dash = data.dash;
	const loadError: string | null = data.error;

	const siteOrigin = dash?.siteOrigin ?? 'https://geo-astro-site.foodstarmelbourne.workers.dev';
	const layers: { key: string; label: string; suffix: string }[] = dash?.layers ?? [];
	type CityMeta = {
		city?: string;
		country?: string | null;
		rank?: number | null;
		stores?: number | null;
		popM?: number | null;
	};
	const citiesMeta: Record<string, CityMeta> = dash?.cities ?? {};
	const files: { name: string; size: number; modified?: string }[] = dash?.files ?? [];
	const manifestGeneratedAt: string | null = dash?.manifestGeneratedAt ?? null;

	// ── build the city × layer matrix from the manifest file list ──
	type Cell = { size: number; sizeMB: number; url: string; name: string };
	type Row = {
		slug: string;
		city: string;
		country: string | null;
		rank: number | null;
		stores: number | null;
		popM: number | null;
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
			let layer = 'base';
			for (let i = layers.length - 1; i >= 0; i--) {
				const sfx = layers[i].suffix;
				if (sfx && f.name.endsWith(`-${sfx}`)) {
					slug = f.name.slice(0, -(sfx.length + 1));
					layer = layers[i].key;
					break;
				}
			}
			const rec = bySlug[slug] ?? {
				slug,
				city: '',
				country: null,
				rank: null,
				stores: null,
				popM: null,
				cells: {},
				have: 0,
				total: 0,
				order: order++
			};
			const sizeMB = f.size / 1048576;
			rec.cells[layer] = {
				size: f.size,
				sizeMB,
				name: f.name,
				url: `${siteOrigin}/basemaps/${f.name}.pmtiles`
			};
			rec.total += f.size;
			bySlug[slug] = rec;
		}
		for (const slug of Object.keys(bySlug)) {
			const rec = bySlug[slug];
			const m = citiesMeta[slug];
			rec.city = m?.city ?? slug.replace(/-/g, ' ');
			rec.country = m?.country ?? null;
			rec.rank = m?.rank ?? null;
			rec.stores = m?.stores ?? null;
			rec.popM = m?.popM ?? null;
			rec.have = Object.keys(rec.cells).length;
		}
		return Object.values(bySlug);
	});

	// ── filters + sorting (dashboard.html controls) ──
	let q = $state('');
	let hideComplete = $state(false);
	let onlyGaps = $state(false);
	let sort = $state('name');
	const gapOf = (r: Row) => layers.length - r.have;

	const visible = $derived.by(() => {
		const query = q.trim().toLowerCase();
		let list = rows.filter((r) => {
			if (hideComplete && gapOf(r) === 0) return false;
			if (onlyGaps && gapOf(r) === 0) return false;
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
			case 'rank':
				list = [...list].sort(
					(a, b) => (b.rank ?? 0) - (a.rank ?? 0) || a.city.localeCompare(b.city)
				);
				break;
			case 'stores':
				list = [...list].sort(
					(a, b) => (b.stores ?? 0) - (a.stores ?? 0) || a.city.localeCompare(b.city)
				);
				break;
			case 'gaps':
				list = [...list].sort((a, b) => gapOf(b) - gapOf(a) || a.city.localeCompare(b.city));
				break;
			case 'size':
				list = [...list].sort((a, b) => b.total - a.total);
				break;
			default:
				list = [...list].sort((a, b) => a.order - b.order);
		}
		return list;
	});

	// ── column + overview stats ──
	type ColStat = { present: number; missing: number; bytes: number };
	const colStats = $derived.by<Record<string, ColStat>>(() => {
		const out: Record<string, ColStat> = {};
		for (const l of layers) {
			const s: ColStat = { present: 0, missing: 0, bytes: 0 };
			for (const r of rows) {
				const c = r.cells[l.key];
				if (c) {
					s.present++;
					s.bytes += c.size;
				} else s.missing++;
			}
			out[l.key] = s;
		}
		return out;
	});

	const totalBytes = $derived(rows.reduce((acc, r) => acc + r.total, 0));
	const completeRows = $derived(rows.filter((r) => gapOf(r) === 0).length);
	const missingCells = $derived(rows.reduce((acc, r) => acc + gapOf(r), 0));

	function fmtBytes(n: number): string {
		if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
		if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
		if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
		return `${n} B`;
	}

	// click a cell → copy the /basemaps URL + open it (dashboard.html behaviour)
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
	const layerLabel = (key: string) => layers.find((l) => l.key === key)?.label ?? key;
</script>

<svelte:head>
	<title>City Basemaps · Geo Admin · Cloudflarebase</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-full space-y-6 px-3 py-5 sm:px-6 sm:py-8">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold tracking-tight">City Basemaps (PMTiles)</h1>
			<p class="text-sm text-muted-foreground">
				{rows.length} cities · {files.length} pmtiles in R2 <code>globe/basemaps/</code>
				{#if manifestGeneratedAt}· manifest {manifestGeneratedAt.slice(0, 10)}
				{/if}
			</p>
		</div>
		<div class="flex items-center gap-2 text-xs text-muted-foreground">
			<span>source:</span>
			<a
				href="https://layers-worker.foodstarmelbourne.workers.dev/dashboard"
				target="_blank"
				rel="noopener"
				class="text-blue-500 hover:underline"
				data-testid="pmtiles-dashboard-json-link">layers-worker /dashboard</a
			>
			<button
				class="rounded-md border px-2 py-1 text-xs transition-colors hover:bg-accent"
				onclick={() => location.reload()}
				data-testid="pmtiles-refresh"
			>
				Refresh
			</button>
		</div>
	</div>

	{#if loadError}
		<div
			class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-3 text-sm text-destructive"
			data-testid="pmtiles-error"
		>
			Could not load the pmtiles dashboard: <code>{loadError}</code>. The layers-worker
			(`layers-worker.foodstarmelbourne.workers.dev`) may not be deployed, or its GLOBE R2 binding
			is misconfigured.
		</div>
	{:else}
		<div class="pdash" data-testid="pmtiles-dashboard">
			<header>
				<h2>City Basemap Coverage</h2>
				<div class="sub">
					ALL pmtiles staged in R2 <code>globe/basemaps/</code> ·
					<a href="{siteOrigin}/atlas" target="_blank" rel="noopener">/atlas</a> ·
					<a href="{siteOrigin}/maps" target="_blank" rel="noopener">/maps</a>
				</div>
			</header>

			<div class="cards">
				<div class="card">
					<h3>Overview</h3>
					<div class="nums">
						<span><b>{rows.length}</b>cities</span>
						<span><b>{layers.length}</b>layers</span>
						<span><b>{completeRows}</b>complete</span>
						<span class="m"><b>{missingCells}</b>gaps</span>
						<span class="p"><b>{fmtBytes(totalBytes)}</b>total</span>
					</div>
				</div>
				{#each layers as l (l.key)}
					<div class="card">
						<h3>{l.label}</h3>
						<div class="nums">
							<span><b>{colStats[l.key]?.present ?? 0}</b>present</span>
							<span class="m"><b>{colStats[l.key]?.missing ?? 0}</b>missing</span>
							<span class="mm"><b>{fmtBytes(colStats[l.key]?.bytes ?? 0)}</b>bytes</span>
						</div>
					</div>
				{/each}
			</div>

			<div class="legend">
				<span><span class="chip ok"></span> pmtiles present in R2 (click = copy URL + open)</span>
				<span><span class="chip missing"></span> not staged</span>
			</div>

			<div class="controls">
				<input
					type="text"
					placeholder="Search city / slug / country…"
					bind:value={q}
					data-testid="pmtiles-search"
				/>
				<label
					><input type="checkbox" bind:checked={hideComplete} data-testid="pmtiles-hide-complete" />
					hide complete rows</label
				>
				<label
					><input type="checkbox" bind:checked={onlyGaps} data-testid="pmtiles-only-gaps" />
					only rows with gaps</label
				>
				<select bind:value={sort} data-testid="pmtiles-sort" class="tbl-sel">
					<option value="name">Sort: name A–Z</option>
					<option value="rank">Sort: rank</option>
					<option value="stores">Sort: chain stores</option>
					<option value="gaps">Sort: most gaps first</option>
					<option value="size">Sort: total size</option>
					<option value="manifest">Sort: manifest order</option>
				</select>
				<span class="count">Showing {visible.length} of {rows.length} cities</span>
			</div>

			<div class="wrap">
				<table>
					<thead>
						<tr>
							<th> City </th>
							<th>Have</th>
							{#each layers as l (l.key)}
								<th>
									{l.label}
									<span class="thc"
										><i style="color:#6fe3a1">{colStats[l.key]?.present ?? 0}</i> ok ·
										<i style="color:#ff8fa3">{colStats[l.key]?.missing ?? 0}</i> missing</span
									>
								</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each visible as r (r.slug)}
							<tr>
								<td class="citycell">
									<b>{r.city}</b>
									<span class="meta">{r.slug}</span>
									<span class="cont"
										>{r.country ?? '—'}
										{#if r.rank}· rank {r.rank}{/if}
										{#if r.stores}· {r.stores} stores{/if}
										{#if r.popM}· {r.popM}M{/if}</span
									>
								</td>
								<td>
									<span
										class={['badge', r.have === layers.length ? 'all' : r.have <= 2 ? 'low' : '']}
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
												title="{c.name} · {c.sizeMB.toFixed(1)} MB"
												onclick={() => openCell(c)}
												data-testid="cell-{r.slug}-{l.key}"
											></button>
										{:else}
											<button
												class="dot missing"
												title="MISSING from R2 · {layerLabel(l.key)}"
												onclick={() =>
													showToast(
														`no ${siteOrigin}/basemaps/${r.slug}${l.suffix ? `-${l.suffix}` : ''}.pmtiles`
													)}
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
				<span class="flabel">Names resolved from the live manifest ({rows.length} city rows).</span>
			</div>
		</div>

		<div class={['toast', toastOn && 'show']}>{toastMsg}</div>
	{/if}
</div>

<style>
	/* Port of atlas/dashboard.html — self-contained dark coverage matrix. */
	.pdash {
		--bg: #0b0f14;
		--panel: #111823;
		--panel2: #0e141d;
		--border: #1f2a38;
		--text: #dbe4ee;
		--muted: #7d8b9d;
		--accent: #4cc2ff;
		--ok: #1f7a44;
		--ok-border: #2e9e5b;
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
	.pdash .sub code {
		background: var(--panel2);
		border: 1px solid var(--border);
		border-radius: 5px;
		padding: 0 5px;
		font-size: 11px;
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
	.pdash .card .nums .m b {
		color: #ff8fa3;
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
		border: 1px solid;
	}
	.pdash .chip.ok {
		background: var(--ok);
		border-color: var(--ok-border);
	}
	.pdash .chip.missing {
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
		background: var(--ok);
		border-color: var(--ok-border);
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
		border-color: var(--ok-border);
	}
	.pdash .badge.low {
		color: #ff8fa3;
		border-color: var(--missing-border);
	}
	.pdash .foot {
		margin-top: 12px;
		font-size: 11.5px;
		color: var(--muted);
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
