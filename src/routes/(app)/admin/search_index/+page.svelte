<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import {
		Search,
		RefreshCw,
		Clock,
		CheckCircle2,
		XCircle,
		Database,
		CalendarClock
	} from '@lucide/svelte';

	let { data, form } = $props();

	const geoBase = 'https://geo-astro-site.foodstarmelbourne.workers.dev';

	let running = $state(false);
	let savingInterval = $state(false);

	let status = $derived(data.overview?.status ?? null);
	let config = $derived(data.overview?.config ?? null);
	let loadError = $derived(data.overview?.error ?? null);
	let lastRun = $derived(status?.lastRunAt ? new Date(status.lastRunAt) : null);

	// Cadence options — weekly default, down to every 5 minutes. If the stored
	// value is a custom number, synthesize a label so the select still shows it.
	const INTERVALS = [
		{ minutes: 10080, label: 'Weekly' },
		{ minutes: 1440, label: 'Daily' },
		{ minutes: 360, label: 'Every 6 hours' },
		{ minutes: 60, label: 'Hourly' },
		{ minutes: 15, label: 'Every 15 minutes' },
		{ minutes: 5, label: 'Every 5 minutes' }
	];
	function intervalLabel(minutes: number): string {
		return (
			INTERVALS.find((i) => i.minutes === minutes)?.label ??
			`Every ${minutes.toLocaleString()} minutes`
		);
	}
	let intervalMinutes = $derived(config?.intervalMinutes ?? 10080);
	let intervalOptions = $derived(
		INTERVALS.some((i) => i.minutes === intervalMinutes)
			? INTERVALS
			: [{ minutes: intervalMinutes, label: intervalLabel(intervalMinutes) }, ...INTERVALS]
	);
	let nextDue = $derived(lastRun ? new Date(lastRun.getTime() + intervalMinutes * 60_000) : null);

	// "x ago" ticker for the last update time.
	let ago = $state('');
	$effect(() => {
		if (!lastRun) {
			ago = '';
			return;
		}
		function tick() {
			const s = Math.max(0, Math.floor((Date.now() - lastRun!.getTime()) / 1000));
			ago =
				s < 90
					? `${s}s ago`
					: s < 3600
						? `${Math.floor(s / 60)}m ago`
						: s < 86400
							? `${Math.floor(s / 3600)}h ago`
							: `${Math.floor(s / 86400)}d ago`;
		}
		tick();
		const id = setInterval(tick, 15000);
		return () => clearInterval(id);
	});

	// While an update is running, poll for progress (the heavy rebuild runs
	// queue-chained on geo-astro-site, so "Run now" returns before it finishes).
	$effect(() => {
		if (!status?.running) return;
		const id = setInterval(() => invalidateAll(), 10000);
		return () => clearInterval(id);
	});

	let docs = $derived(data.docs?.docs ?? []);
	let docTotal = $derived(data.docs?.total ?? 0);
	let docLimit = $derived(data.docs?.limit ?? 25);
	let docOffset = $derived(data.docs?.offset ?? data.offset ?? 0);

	function pageHref(offset: number): string {
		const params = new SvelteURLSearchParams();
		if (data.q) params.set('q', data.q);
		if (data.type) params.set('type', data.type);
		if (offset > 0) params.set('offset', String(offset));
		const s = params.toString();
		return s ? `/admin/search_index?${s}` : '/admin/search_index';
	}
	let prevOffset = $derived(docOffset > 0 ? Math.max(0, docOffset - docLimit) : null);
	let nextOffset = $derived(docOffset + docLimit < docTotal ? docOffset + docLimit : null);

	function fmtTime(d: Date | null): string {
		return d ? d.toUTCString() : '—';
	}
</script>

<svelte:head>
	<title>Search Index · Geo Admin · Cloudflarebase</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-4xl p-6">
	<header class="mb-6">
		<h1 class="flex items-center gap-2 text-lg font-semibold">
			<Search class="size-4 text-muted-foreground" />
			Search Index
		</h1>
		<p class="mt-1 text-sm text-muted-foreground">
			Site search (the <code class="rounded bg-muted px-1">/search</code> page) runs on a document index
			— a D1 table plus Vectorize embeddings on geo-astro-site. This tab shows when it was last updated,
			sets the update cadence, triggers an update on demand, and lists what is indexed.
		</p>
	</header>

	<section
		class="rounded-lg border border-border/40 bg-background p-5 shadow-sm"
		data-testid="search-index-status"
	>
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div class="flex items-center gap-2 text-sm font-medium">
				<Clock class="size-4 text-muted-foreground" />
				Last updated
			</div>
			{#if status?.running}
				<span
					class="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600"
					data-testid="search-index-running-badge"
				>
					<RefreshCw class="size-3 animate-spin" /> updating…
				</span>
			{:else if status?.ok === false && status?.error}
				<span
					class="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive"
					data-testid="search-index-error-badge"
				>
					<XCircle class="size-3" /> failed
				</span>
			{:else if status?.lastRunAt}
				<span
					class="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600"
					data-testid="search-index-ok-badge"
				>
					<CheckCircle2 class="size-3" /> ok
				</span>
			{/if}
		</div>

		{#if loadError && !status}
			<p class="mt-3 text-sm text-destructive" data-testid="search-index-load-error">
				Could not read the index status: {loadError}
			</p>
		{:else if status?.lastRunAt}
			<dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
				<dt class="text-muted-foreground">When</dt>
				<dd data-testid="search-index-last-updated">
					{fmtTime(lastRun)} <span class="text-muted-foreground">({ago})</span>
				</dd>
				<dt class="text-muted-foreground">Trigger</dt>
				<dd class="capitalize" data-testid="search-index-trigger">{status.trigger ?? '—'}</dd>
				<dt class="text-muted-foreground">Documents</dt>
				<dd>
					{status.indexed ?? '—'} indexed
					{#if status.total}
						<span class="text-muted-foreground">/ {status.total} known</span>
					{/if}
				</dd>
				<dt class="text-muted-foreground">Duration</dt>
				<dd>
					{#if status.durationMs != null}
						{status.durationMs < 60_000
							? `${(status.durationMs / 1000).toFixed(1)}s`
							: `${Math.round(status.durationMs / 60_000)}m`}
					{:else}
						—
					{/if}
				</dd>
				<dt class="text-muted-foreground">Schedule</dt>
				<dd data-testid="search-index-schedule">
					{intervalLabel(intervalMinutes)}
					<span class="text-muted-foreground">— cron wakes every 5 min, runs when due</span>
				</dd>
				<dt class="text-muted-foreground">Next auto-update</dt>
				<dd data-testid="search-index-next-due">
					{#if status.running}
						<span class="text-amber-600">in progress…</span>
					{:else}
						{fmtTime(nextDue)}
					{/if}
				</dd>
			</dl>
			{#if status.stage}
				<p class="mt-2 rounded bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
					Indexing <span class="font-medium">{status.stage.type}</span>
					{#if status.stage.total != null}
						— {status.stage.offset}/{status.stage.total}
					{/if}
				</p>
			{/if}
		{:else}
			<p class="mt-3 text-sm text-muted-foreground" data-testid="search-index-never-run">
				{status?.neverRun
					? 'The index has not been updated yet — push the button to update it now.'
					: `Could not read status: ${status?.error ?? loadError ?? 'unknown error'}`}
			</p>
		{/if}

		{#if status?.ok === false && status?.error}
			<p class="mt-2 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">
				{status.error}
			</p>
		{/if}
	</section>

	<section class="mt-4 grid gap-3 sm:grid-cols-2">
		<!-- Schedule -->
		<div class="rounded-lg border border-border/40 bg-background p-5 shadow-sm">
			<div class="flex items-center gap-2 text-sm font-medium">
				<CalendarClock class="size-4 text-muted-foreground" />
				Update schedule
			</div>
			<form
				method="POST"
				action="?/interval"
				class="mt-3 flex items-center gap-2"
				use:enhance={() => {
					savingInterval = true;
					return async ({ update }) => {
						await update;
						savingInterval = false;
					};
				}}
			>
				<select
					name="intervalMinutes"
					data-testid="search-index-interval-select"
					class="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
				>
					{#each intervalOptions as opt (opt.minutes)}
						<option value={opt.minutes} selected={opt.minutes === intervalMinutes}>
							{opt.label}
						</option>
					{/each}
				</select>
				<button
					type="submit"
					disabled={savingInterval}
					data-testid="search-index-interval-save"
					class="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-60"
				>
					{savingInterval ? 'Saving…' : 'Save'}
				</button>
			</form>
			{#if form?.success && form?.intervalMinutes}
				<p class="mt-2 text-xs text-emerald-600" data-testid="search-index-interval-ok">
					Schedule saved — {intervalLabel(form.intervalMinutes)}.
				</p>
			{:else if form?.success === false && form?.error}
				<p class="mt-2 text-xs text-destructive">{form.error}</p>
			{/if}
		</div>

		<!-- Run now -->
		<div class="rounded-lg border border-border/40 bg-background p-5 shadow-sm">
			<div class="flex items-center gap-2 text-sm font-medium">
				<RefreshCw class="size-4 text-muted-foreground" />
				Manual update
			</div>
			<form
				method="POST"
				action="?/run"
				class="mt-3"
				use:enhance={() => {
					running = true;
					return async ({ update }) => {
						await update;
						running = false;
					};
				}}
			>
				<button
					type="submit"
					disabled={running || status?.running}
					data-testid="search-index-run-button"
					class="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
				>
					<RefreshCw class="size-4 {running || status?.running ? 'animate-spin' : ''}" />
					{status?.running ? 'Update running…' : running ? 'Starting…' : 'Update search index now'}
				</button>
			</form>
			{#if form?.success && form?.runId}
				<p class="mt-2 text-xs text-emerald-600" data-testid="search-index-run-ok">
					Update queued ({form.runId}) — this page polls while it runs.
				</p>
			{:else if form?.success === false && form?.error}
				<p class="mt-2 text-xs text-destructive" data-testid="search-index-run-error">
					{form.error}
				</p>
			{/if}
		</div>
	</section>

	<!-- The index itself -->
	<section class="mt-4 rounded-lg border border-border/40 bg-background p-5 shadow-sm">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div class="flex items-center gap-2 text-sm font-medium">
				<Database class="size-4 text-muted-foreground" />
				Indexed documents
				<span class="text-muted-foreground" data-testid="search-index-doc-total"
					>({docTotal.toLocaleString()})</span
				>
			</div>
			<form method="GET" class="flex items-center gap-2" data-sveltekit-keepfocus>
				{#if data.type}<input type="hidden" name="type" value={data.type} />{/if}
				<input
					type="search"
					name="q"
					value={data.q}
					placeholder="Filter by title / slug…"
					class="w-48 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
				/>
				<select
					name="type"
					data-testid="search-index-type-filter"
					class="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
				>
					<option value="" selected={data.type === ''}>All types</option>
					<option value="map" selected={data.type === 'map'}>Maps</option>
					<option value="article" selected={data.type === 'article'}>Articles</option>
					<option value="write" selected={data.type === 'write'}>Write</option>
					<option value="blog" selected={data.type === 'blog'}>Blog</option>
					<option value="guide" selected={data.type === 'guide'}>Guides</option>
				</select>
				<button
					type="submit"
					class="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
				>
					Filter
				</button>
			</form>
		</div>

		{#if data.docs?.ok === false}
			<p class="mt-3 text-sm text-destructive">
				Could not list the index: {data.docs.error ?? 'unknown error'}
			</p>
		{:else if docs.length === 0}
			<p class="mt-3 text-sm text-muted-foreground">
				{data.q || data.type
					? 'No indexed documents match the filter.'
					: 'Nothing indexed yet — run an update first.'}
			</p>
		{:else}
			<div class="mt-3 overflow-x-auto">
				<table class="w-full text-left text-sm">
					<thead>
						<tr
							class="border-b border-border/40 text-xs tracking-wide text-muted-foreground uppercase"
						>
							<th class="py-2 pr-3 font-medium">Title</th>
							<th class="py-2 pr-3 font-medium">Type</th>
							<th class="py-2 pr-3 font-medium">Slug</th>
							<th class="py-2 font-medium">Updated</th>
						</tr>
					</thead>
					<tbody data-testid="search-index-doc-rows">
						{#each docs as d (d.id)}
							<tr class="border-b border-border/20">
								<td class="max-w-[22rem] truncate py-2 pr-3">
									<a
										href="{geoBase}{d.url}"
										target="_blank"
										rel="noopener"
										class="underline decoration-border underline-offset-2 hover:decoration-foreground"
									>
										{d.title || d.slug}
									</a>
								</td>
								<td class="py-2 pr-3">
									<span class="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
										{d.type}
									</span>
								</td>
								<td class="py-2 pr-3 font-mono text-xs text-muted-foreground">{d.slug}</td>
								<td class="py-2 text-xs text-muted-foreground">
									{d.updated_at
										? new Date(d.updated_at).toISOString().slice(0, 16).replace('T', ' ')
										: '—'}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			{#if prevOffset !== null || nextOffset !== null}
				<!-- eslint-disable svelte/no-navigation-without-resolve -- legacy /admin/* routes are hard-coded paths outside resolve() -->
				<div class="mt-3 flex items-center justify-between text-sm">
					{#if prevOffset !== null}
						<a
							href={pageHref(prevOffset)}
							class="rounded-md border border-border px-3 py-1.5 hover:bg-muted"
						>
							← Previous
						</a>
					{:else}
						<span></span>
					{/if}
					<span class="text-xs text-muted-foreground">
						{docOffset + 1}–{Math.min(docOffset + docLimit, docTotal)} of {docTotal.toLocaleString()}
					</span>
					{#if nextOffset !== null}
						<a
							href={pageHref(nextOffset)}
							class="rounded-md border border-border px-3 py-1.5 hover:bg-muted"
						>
							Next →
						</a>
					{:else}
						<span></span>
					{/if}
				</div>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
			{/if}
		{/if}
	</section>
</div>
