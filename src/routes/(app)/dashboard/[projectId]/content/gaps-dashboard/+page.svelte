<script lang="ts">
	let { data } = $props();

	const gaps = data.gaps;
	const loadError: string | null = data.error;
	const siteOrigin = 'https://geo-astro-site.foodstarmelbourne.workers.dev';

	// Mirror of workers/layers/src/gaps.js LAYERS (labels + suffixes for the matrix)
	const LAYER_DEFS: { key: string; label: string; suffix: string }[] = [
		{ key: 'base', label: 'Buildings', suffix: '' },
		{ key: 'terrain', label: 'Terrain', suffix: 'terrain' },
		{ key: 'satellite', label: 'Satellite', suffix: 'satellite' },
		{ key: 'population', label: 'Population', suffix: 'population' },
		{ key: 'speed', label: 'Internet Speed', suffix: 'speed' },
		{ key: 'transit', label: 'Mobility', suffix: 'transit' },
		{ key: 'power', label: 'Power', suffix: 'power' },
		{ key: 'bathymetry', label: 'Bathymetry', suffix: 'bathymetry' },
		{ key: 'mapillary', label: 'Mapillary', suffix: 'mapillary' },
		{ key: 'kartaview', label: 'KartaView', suffix: 'kartaview' }
	];

	const candidates: { slug: string; display: string; hasBase: boolean; missing: string[] }[] =
		gaps?.candidates ?? [];
	const manifestGeneratedAt: string | null = gaps?.manifestGeneratedAt ?? null;

	type Row = {
		slug: string;
		display: string;
		hasBase: boolean;
		missing: string[];
		gaps: number;
		order: number;
	};
	const rows = $derived.by<Row[]>(() =>
		candidates.map((c, i) => ({
			slug: c.slug,
			display: c.display || c.slug,
			hasBase: !!c.hasBase,
			missing: Array.isArray(c.missing) ? c.missing : [],
			gaps: Array.isArray(c.missing) ? c.missing.length : 0,
			order: i
		}))
	);

	// ── filters + sorting ──
	let q = $state('');
	let hideComplete = $state(false);
	let includeNoBase = $state(false);
	let sort = $state('gaps');

	const visible = $derived.by(() => {
		const query = q.trim().toLowerCase();
		let list = rows.filter((r) => {
			if (!includeNoBase && !r.hasBase) return false;
			if (hideComplete && r.gaps === 0) return false;
			if (query) {
				const hay = `${r.display} ${r.slug}`.toLowerCase();
				if (!hay.includes(query)) return false;
			}
			return true;
		});
		switch (sort) {
			case 'gaps':
				list = [...list].sort((a, b) => b.gaps - a.gaps || a.display.localeCompare(b.display));
				break;
			case 'name':
				list = [...list].sort(
					(a, b) => a.display.localeCompare(b.display) || a.slug.localeCompare(b.slug)
				);
				break;
			default:
				break;
		}
		return list;
	});

	// ── column stats (over ALL candidates, mirroring /gaps perLayer) ──
	const colStats = $derived.by<Record<string, { present: number; missing: number }>>(() => {
		const out: Record<string, { present: number; missing: number }> = {};
		for (const l of LAYER_DEFS) {
			const s = { present: 0, missing: 0 };
			for (const c of candidates) {
				if (l.key === 'base') {
					if (c.hasBase) s.present++;
					else s.missing++;
				} else if (c.missing.includes(l.key)) s.missing++;
				else s.present++;
			}
			out[l.key] = s;
		}
		return out;
	});

	const totalGapCells = $derived(
		rows.reduce((acc, r) => acc + (r.hasBase ? r.gaps : LAYER_DEFS.length - 1), 0)
	);
	const completeRows = $derived(rows.filter((r) => r.hasBase && r.gaps === 0).length);

	// click a missing cell → toast the extract command for that layer+slug
	let toastMsg = $state('');
	let toastOn = $state(false);
	let toastTimer: ReturnType<typeof setTimeout> | undefined;
	function showToast(msg: string) {
		toastMsg = msg;
		toastOn = true;
		if (toastTimer) clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toastOn = false), 2600);
	}
	const EXTRACT_CMD: Record<string, string> = {
		base: 'node layer/extract-anchor-pmtiles.mjs && node layer/upload-anchor-pmtiles.mjs',
		terrain: 'node layer/extract-anchor-pmtiles.mjs && node layer/upload-anchor-pmtiles.mjs',
		satellite: 'node layer/extract-city-satellite.mjs --slug {slug}',
		population: 'node layer/extract-city-population.mjs --slug {slug}',
		speed: 'node layer/extract-city-speed.mjs --slug {slug}',
		transit: 'node layer/extract-city-transit.mjs --slug {slug}',
		power: 'node layer/extract-city-power.mjs --slug {slug}',
		bathymetry: 'node layer/extract-city-bathymetry.mjs --slug {slug}',
		mapillary: 'node layer/extract-city-mapillary.mjs --slug {slug}',
		kartaview: 'node layer/extract-city-kartaview.mjs --slug {slug}'
	};
	const cellPmtilesUrl = (slug: string, key: string) =>
		`${siteOrigin}/basemaps/${slug}${key === 'base' ? '' : `-${key}`}.pmtiles`;

	function missingClick(r: Row, l: { key: string; label: string }) {
		const cmd = (EXTRACT_CMD[l.key] ?? '').replace('{slug}', r.slug);
		showToast(`MISSING ${l.label} → ${cellPmtilesUrl(r.slug, l.key)}${cmd ? `  ·  ${cmd}` : ''}`);
	}
	function presentClick(r: Row, l: { key: string; suffix: string }) {
		const url = cellPmtilesUrl(r.slug, l.key);
		if (navigator.clipboard) navigator.clipboard.writeText(url).catch(() => {});
		showToast(`${url}  (copied)`);
		window.open(url, '_blank');
	}
</script>

<svelte:head>
	<title>Layer Gaps · Geo Admin · Cloudflarebase</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-full space-y-6 px-3 py-5 sm:px-6 sm:py-8">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold tracking-tight">Layer Gaps (per-city missing pmtiles)</h1>
			<p class="text-sm text-muted-foreground">
				{gaps?.totals.candidates ?? 0} candidates · {gaps?.totals.withBase ?? 0} with base ·
				{gaps?.totals.noBase ?? 0} without base · manifest {gaps?.manifestFiles ?? 0} files
				{#if manifestGeneratedAt}· {manifestGeneratedAt.slice(0, 10)}{/if}
			</p>
		</div>
		<div class="flex items-center gap-2 text-xs text-muted-foreground">
			<span>source:</span>
			<a
				href="https://layers-worker.foodstarmelbourne.workers.dev/gaps"
				target="_blank"
				rel="noopener"
				class="text-blue-500 hover:underline"
				data-testid="gaps-json-link">layers-worker /gaps</a
			>
			<button
				class="rounded-md border px-2 py-1 text-xs transition-colors hover:bg-accent"
				onclick={() => location.reload()}
				data-testid="gaps-refresh"
			>
				Refresh
			</button>
		</div>
	</div>

	{#if loadError}
		<div
			class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-3 text-sm text-destructive"
			data-testid="gaps-error"
		>
			Could not load the gaps dashboard: <code>{loadError}</code>. The layers-worker
			(`layers-worker.foodstarmelbourne.workers.dev`) may not be deployed, or its GLOBE R2 binding
			is misconfigured.
		</div>
	{:else}
		<div class="pdash" data-testid="gaps-dashboard">
			<header>
				<h2>Missing City-Layer Matrix</h2>
				<div class="sub">
					live from R2 <code>globe/basemaps/manifest.json</code> ·
					<a href="{siteOrigin}/atlas" target="_blank" rel="noopener">/atlas</a> · rows without base cannot
					render the city view — extract base first
				</div>
			</header>

			<div class="cards">
				<div class="card">
					<h3>Overview</h3>
					<div class="nums">
						<span><b>{gaps?.totals.candidates ?? 0}</b>candidates</span>
						<span><b>{completeRows}</b>complete</span>
						<span class="m"><b>{totalGapCells}</b>missing cells</span>
					</div>
				</div>
				{#each LAYER_DEFS.slice(1) as l (l.key)}
					<div class="card">
						<h3>{l.label}</h3>
						<div class="nums">
							<span class="m"><b>{colStats[l.key]?.missing ?? 0}</b>missing</span>
							<span><b>{colStats[l.key]?.present ?? 0}</b>present</span>
						</div>
					</div>
				{/each}
			</div>

			<div class="legend">
				<span><span class="chip ok"></span> pmtiles staged in R2 (click = copy URL + open)</span>
				<span><span class="chip missing"></span> missing (click = extract command)</span>
				<span
					><span class="chip nobase"></span> row without base pmtiles (city view cannot render)</span
				>
			</div>

			<div class="controls">
				<input
					type="text"
					placeholder="Search city / slug…"
					bind:value={q}
					data-testid="gaps-search"
				/>
				<label
					><input type="checkbox" bind:checked={hideComplete} data-testid="gaps-hide-complete" /> hide
					complete rows</label
				>
				<label
					><input type="checkbox" bind:checked={includeNoBase} data-testid="gaps-include-nobase" /> include
					rows without base</label
				>
				<select bind:value={sort} data-testid="gaps-sort" class="tbl-sel">
					<option value="gaps">Sort: most gaps first</option>
					<option value="name">Sort: name A–Z</option>
				</select>
				<span class="count">Showing {visible.length} of {rows.length} candidates</span>
			</div>

			<div class="wrap">
				<table>
					<thead>
						<tr>
							<th>City</th>
							<th>Gaps</th>
							{#each LAYER_DEFS as l (l.key)}
								<th>
									{l.label}
									<span class="thc">
										<i style="color:#6fe3a1">{colStats[l.key]?.present ?? 0}</i> ok ·
										<i style="color:#ff8fa3">{colStats[l.key]?.missing ?? 0}</i> missing</span
									>
								</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each visible as r (r.slug)}
							<tr class:nobase={!r.hasBase}>
								<td class="citycell">
									<b>{r.display}</b>
									<span class="meta">{r.slug}</span>
									{#if !r.hasBase}<span class="nb">no base</span>{/if}
									<span class="cont">
										<a href="{siteOrigin}/atlas/{r.slug}-city-atlas" target="_blank" rel="noopener"
											>atlas ↗</a
										></span
									>
								</td>
								<td>
									<span class={['badge', r.gaps === 0 ? 'all' : r.gaps > 4 ? 'low' : '']}>
										{r.gaps}/{LAYER_DEFS.length - 1}
									</span>
								</td>
								{#each LAYER_DEFS as l (r.slug + l.key)}
									{@const isMissing = l.key === 'base' ? !r.hasBase : r.missing.includes(l.key)}
									<td class="cell">
										{#if isMissing}
											<button
												class="dot missing"
												title="MISSING · {l.label}"
												onclick={() => missingClick(r, l)}
												data-testid="cell-{r.slug}-{l.key}"
											></button>
										{:else}
											<button
												class="dot ok"
												title={cellPmtilesUrl(r.slug, l.key)}
												onclick={() => presentClick(r, l)}
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
					After extracting: upload with <code
						>node layer/upload-city-layers.mjs --layers &lt;layer&gt;</code
					>
					then refresh the manifest with <code>node layer/basemaps-manifest-update.mjs</code> — gaps
					recompute live. Audit file: <code>basemaps/gaps.md</code> (regenerate via
					<code>node --dns-result-order=ipv4first layer/generate-gaps.mjs</code>)
				</span>
			</div>
		</div>

		<div class={['toast', toastOn && 'show']}>{toastMsg}</div>
	{/if}
</div>

<style>
	/* Same self-contained dark coverage matrix as the pmtiles/streetview dashboards. */
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
	.pdash .chip.nobase {
		background: #26102e;
		border-color: #7e3a8f;
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
	.pdash tbody tr.nobase {
		background: #150d1a;
	}
	.pdash .citycell b {
		font-weight: 600;
	}
	.pdash .citycell .meta {
		color: var(--accent);
		font-size: 11px;
		margin-left: 6px;
	}
	.pdash .citycell .nb {
		margin-left: 6px;
		font-size: 10px;
		color: #d8a6ff;
		border: 1px solid #7e3a8f;
		border-radius: 999px;
		padding: 1px 6px;
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
		max-width: 80vw;
	}
	.toast.show {
		opacity: 1;
	}
</style>
