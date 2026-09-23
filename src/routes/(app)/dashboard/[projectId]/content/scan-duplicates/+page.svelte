<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import {
		RefreshCw,
		Clock,
		CheckCircle2,
		XCircle,
		Copy,
		CopyCheck,
		Files,
		Database,
		Trash2,
		ScanSearch
	} from '@lucide/svelte';

	let { data, form } = $props();

	let scanning = $state(false);
	let scanningHarness = $state(false);
	let deleting = $state(false);

	let report = $derived(form?.report ?? data.report ?? null);
	let reportError = $derived(form?.report ? null : data.reportError);

	let pages = $derived(report?.pages ?? null);
	let basemaps = $derived(report?.basemaps ?? null);
	let datalake = $derived(report?.datalake ?? null);
	let harness = $derived(report?.harness ?? null);

	let totalDups = $derived(
		(pages?.identicalContentCount ?? 0) +
			(pages?.routeRiskCount ?? 0) +
			(basemaps?.identicalContentCount ?? 0) +
			(basemaps?.nameCollisionsCount ?? 0) +
			(datalake?.identicalContentCount ?? 0) +
			(datalake?.sameBasenameCount ?? 0) +
			(harness?.cacfgDupCount ?? 0) +
			(harness?.vtabDupCount ?? 0)
	);

	// Keys pre-selected for delete: for each etag-dup group keep the first key
	// (lexicographic — stable) and queue the rest.
	let basemapDeleteKeys = $state<string[]>([]);
	let datalakeDeleteKeys = $state<string[]>([]);

	$effect(() => {
		const groups = basemaps?.identicalContent ?? [];
		basemapDeleteKeys = groups.flatMap((g) => (g.keys ?? []).slice(1));
	});
	$effect(() => {
		const groups = datalake?.identicalContent ?? [];
		datalakeDeleteKeys = groups.flatMap((g) => (g.keys ?? []).slice(1));
	});

	function fmtMs(ms?: number): string {
		if (ms == null) return '—';
		return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
	}

	function truncate(s: string, n = 80): string {
		return s.length > n ? s.slice(0, n - 1) + '…' : s;
	}
</script>

<svelte:head>
	<title>Scan Duplicates · Geo Admin · Cloudflarebase</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-5xl space-y-6 px-3 py-5 sm:px-6 sm:py-8">
	<div>
		<h1 class="text-2xl font-bold tracking-tight">Scan Duplicates</h1>
		<p class="mt-1 text-sm text-muted-foreground">
			Finds duplicate <code class="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">.astro</code>
			pages, byte-identical / name-colliding PMTiles in
			<code class="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">globe/basemaps</code>, duplicated
			layers in
			<code class="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">geo-datalake</code>, and duplicate
			layer-harness keys (			<code class="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">__caCfg</code>
			/ <code class="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">.vtab</code>). Run a manual
			scan below; results are stored in R2.
		</p>
	</div>

	<!-- Status + manual scan button -->
	<section class="rounded-lg border bg-card p-5" data-testid="scan-duplicates-status">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div class="flex items-center gap-2 text-sm font-medium">
				<Clock class="size-4 text-muted-foreground" />
				Last scan
			</div>
			{#if scanning || scanningHarness}
				<Badge variant="outline" class="gap-1 border-amber-600/40 text-xs text-amber-600">
					<RefreshCw class="size-3 animate-spin" /> scanning…
				</Badge>
			{:else if report?.generatedAt}
				<Badge
					variant="outline"
					class="gap-1 border-green-600/40 text-xs text-green-600"
					data-testid="scan-duplicates-ok-badge"
				>
					<CheckCircle2 class="size-3" /> {totalDups} duplicate group{totalDups === 1 ? '' : 's'}
				</Badge>
			{:else}
				<Badge variant="outline" class="gap-1 text-xs text-muted-foreground">never run</Badge>
			{/if}
		</div>

		{#if reportError && !report}
			<p class="mt-3 text-sm text-muted-foreground" data-testid="scan-duplicates-empty">
				{reportError}
			</p>
		{:else if report?.generatedAt}
			<dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
				<dt class="text-muted-foreground">When</dt>
				<dd data-testid="scan-duplicates-generated">
					{new Date(report.generatedAt).toUTCString()}
					{#if report.branch}
						<span class="text-muted-foreground">· branch {report.branch}</span>
					{/if}
				</dd>
				<dt class="text-muted-foreground">Pages</dt>
				<dd>
					{pages?.files ?? '—'} .astro ·
					{pages?.identicalContentCount ?? 0} content clone{pages?.identicalContentCount === 1
						? ''
						: 's'} ·
					{pages?.routeRiskCount ?? 0} basename risk{pages?.routeRiskCount === 1 ? '' : 's'}
					{#if pages?.durationMs != null}<span class="text-muted-foreground"
							>({fmtMs(pages.durationMs)})</span
						>{/if}
				</dd>
				<dt class="text-muted-foreground">Basemaps</dt>
				<dd>
					{basemaps?.files ?? '—'} .pmtiles ·
					{basemaps?.identicalContentCount ?? 0} etag dup group{basemaps?.identicalContentCount ===
					1
						? ''
						: 's'} ·
					{basemaps?.nameCollisionsCount ?? 0} name collision{basemaps?.nameCollisionsCount === 1
						? ''
						: 's'}
					{#if basemaps?.durationMs != null}<span class="text-muted-foreground"
							>({fmtMs(basemaps.durationMs)})</span
						>{/if}
				</dd>
				<dt class="text-muted-foreground">Datalake</dt>
				<dd>
					{datalake?.files ?? '—'} objects ·
					{datalake?.identicalContentCount ?? 0} etag dup group{datalake?.identicalContentCount === 1
						? ''
						: 's'} ·
					{datalake?.sameBasenameCount ?? 0} same-basename{datalake?.sameBasenameCount === 1
						? ''
						: 's'}
					{#if datalake?.durationMs != null}<span class="text-muted-foreground"
							>({fmtMs(datalake.durationMs)})</span
						>{/if}
				</dd>
				<dt class="text-muted-foreground">Harness</dt>
				<dd>
					{harness?.scanned ?? 0}/{harness?.totalCandidates ?? '—'} scanned ·
					{harness?.cacfgDupCount ?? 0} __caCfg dup file{harness?.cacfgDupCount === 1 ? '' : 's'} ·
					{harness?.vtabDupCount ?? 0} .vtab dup file{harness?.vtabDupCount === 1 ? '' : 's'}
					{#if harness && !harness.done}
						<Badge variant="outline" class="ml-2 gap-1 border-amber-600/40 text-xs text-amber-600">
							partial — cursor {harness.cursor}
						</Badge>
					{/if}
				</dd>
			</dl>
		{/if}

		<div class="mt-4 flex flex-wrap gap-3">
			<form
				method="POST"
				action="?/scan"
				use:enhance={() => {
					scanning = true;
					return async ({ update }) => {
						await update;
						scanning = false;
					};
				}}
			>
				<Button
					type="submit"
					disabled={scanning || scanningHarness}
					data-testid="scan-duplicates-run-button"
					class="gap-2"
				>
					<ScanSearch class="size-4 {scanning ? 'animate-pulse' : ''}" />
					{scanning ? 'Scanning…' : 'Scan now'}
				</Button>
			</form>
			<form
				method="POST"
				action="?/scanHarness"
				use:enhance={() => {
					scanningHarness = true;
					return async ({ update }) => {
						await update;
						scanningHarness = false;
					};
				}}
			>
				<Button
					type="submit"
					variant="outline"
					disabled={scanning || scanningHarness || (harness?.done ?? false)}
					data-testid="scan-duplicates-harness-button"
					class="gap-2"
				>
					<RefreshCw class="size-4 {scanningHarness ? 'animate-spin' : ''}" />
					{scanningHarness
						? 'Scanning harness…'
						: harness && !harness.done
							? 'Continue harness scan'
							: 'Re-scan harness'}
				</Button>
			</form>
		</div>
		{#if form?.action === 'scan' && form?.error}
			<p class="mt-2 text-xs text-destructive" data-testid="scan-duplicates-run-error">
				{form.error}
			</p>
		{:else if form?.action === 'scan' && form?.success}
			<p class="mt-2 text-xs text-green-600" data-testid="scan-duplicates-run-ok">
				Scan complete.
			</p>
		{/if}
		{#if form?.action === 'scanHarness' && form?.error}
			<p class="mt-2 text-xs text-destructive">{form.error}</p>
		{:else if form?.action === 'scanHarness' && form?.success}
			<p class="mt-2 text-xs text-green-600" data-testid="scan-duplicates-harness-ok">
				Harness scan {form.done ? 'complete' : `stopped after ${form.batches} batches (cursor budget)`}.
			</p>
		{/if}
	</section>

	<!-- 1. Pages .astro -->
	<section class="rounded-lg border bg-card p-5" data-testid="scan-duplicates-pages">
		<div class="flex items-center gap-2 text-sm font-medium">
			<Files class="size-4 text-muted-foreground" />
			src/pages .astro
		</div>
		{#if !pages}
			<p class="mt-2 text-sm text-muted-foreground">No pages section yet.</p>
		{:else if pages.error}
			<p class="mt-2 text-sm text-destructive">{pages.error}</p>
		{:else}
			{#if (pages.identicalContentCount ?? 0) === 0 && (pages.routeRiskCount ?? 0) === 0}
				<p class="mt-2 text-sm text-green-600">No duplicates found.</p>
			{/if}
			{#if (pages.identicalContentCount ?? 0) > 0}
				<p class="mt-3 text-xs font-medium text-muted-foreground">
					Identical content ({pages.identicalContentCount})
				</p>
				<ul class="mt-1 space-y-1">
					{#each pages.identicalContent ?? [] as group (group.sha)}
						<li class="rounded bg-muted/50 px-2 py-1 font-mono text-[11px]">
							{#each group.paths ?? [] as p, i (p)}
								{i > 0 ? ' ≡ ' : ''}{p}
							{/each}
						</li>
					{/each}
				</ul>
			{/if}
			{#if (pages.routeRiskCount ?? 0) > 0}
				<p class="mt-3 text-xs font-medium text-muted-foreground">
					Basename route risk ({pages.routeRiskCount})
				</p>
				<ul class="mt-1 space-y-1">
					{#each pages.routeRisk ?? [] as group (group.base)}
						<li class="rounded bg-muted/50 px-2 py-1 font-mono text-[11px]">
							{#each group.paths ?? [] as p, i (p)}
								{i > 0 ? ' | ' : ''}{p}
							{/each}
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</section>

	<!-- 2. Basemaps -->
	<section class="rounded-lg border bg-card p-5" data-testid="scan-duplicates-basemaps">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div class="flex items-center gap-2 text-sm font-medium">
				<Copy class="size-4 text-muted-foreground" />
				globe/basemaps .pmtiles
			</div>
			{#if basemapDeleteKeys.length > 0}
				<form
					method="POST"
					action="?/deleteKeys"
					use:enhance={() => {
						deleting = true;
						return async ({ update }) => {
							await update;
							deleting = false;
						};
					}}
				>
					<input type="hidden" name="bucket" value="globe" />
					<input type="hidden" name="keys" value={JSON.stringify(basemapDeleteKeys)} />
					<Button
						type="submit"
						variant="outline"
						size="sm"
						disabled={deleting}
						data-testid="scan-duplicates-delete-basemaps"
						class="gap-1 text-destructive"
					>
						<Trash2 class="size-3 {deleting ? 'animate-pulse' : ''}" />
						Delete {basemapDeleteKeys.length} etag duplicate{basemapDeleteKeys.length === 1
							? ''
							: 's'}
					</Button>
				</form>
			{/if}
		</div>
		{#if !basemaps}
			<p class="mt-2 text-sm text-muted-foreground">No basemaps section yet.</p>
		{:else if basemaps.error}
			<p class="mt-2 text-sm text-destructive">{basemaps.error}</p>
		{:else}
			{#if (basemaps.identicalContentCount ?? 0) === 0 && (basemaps.nameCollisionsCount ?? 0) === 0}
				<p class="mt-2 text-sm text-green-600">No duplicates found.</p>
			{/if}
			{#if (basemaps.identicalContentCount ?? 0) > 0}
				<p class="mt-3 text-xs font-medium text-muted-foreground">
					Byte-identical (same etag) — {basemaps.identicalContentCount} group{basemaps.identicalContentCount ===
					1
						? ''
						: 's'}
				</p>
				<ul class="mt-1 space-y-1">
					{#each basemaps.identicalContent ?? [] as group, i (group.etag ?? i)}
						<li class="rounded bg-muted/50 px-2 py-1 font-mono text-[11px]">
							<span class="text-muted-foreground">{group.size?.toLocaleString()} B</span>
							{#each group.keys ?? [] as k, j (k)}
								{j > 0 ? ' ≡ ' : ' '}{truncate(k, 70)}
							{/each}
						</li>
					{/each}
				</ul>
			{/if}
			{#if (basemaps.nameCollisionsCount ?? 0) > 0}
				<p class="mt-3 text-xs font-medium text-muted-foreground">
					Name-normalized collisions — {basemaps.nameCollisionsCount}
				</p>
				<ul class="mt-1 space-y-1">
					{#each basemaps.nameCollisions ?? [] as group, i (group.city ?? i)}
						<li class="rounded bg-muted/50 px-2 py-1 font-mono text-[11px]">
							{group.city}/{group.layer}:
							{#each group.keys ?? [] as k, j (k)}
								{j > 0 ? ' | ' : ' '}{truncate(k, 70)}
							{/each}
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</section>

	<!-- 3. Datalake -->
	<section class="rounded-lg border bg-card p-5" data-testid="scan-duplicates-datalake">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div class="flex items-center gap-2 text-sm font-medium">
				<Database class="size-4 text-muted-foreground" />
				geo-datalake sources/
			</div>
			{#if datalakeDeleteKeys.length > 0}
				<form
					method="POST"
					action="?/deleteKeys"
					use:enhance={() => {
						deleting = true;
						return async ({ update }) => {
							await update;
							deleting = false;
						};
					}}
				>
					<input type="hidden" name="bucket" value="geo-datalake" />
					<input type="hidden" name="keys" value={JSON.stringify(datalakeDeleteKeys)} />
					<Button
						type="submit"
						variant="outline"
						size="sm"
						disabled={deleting}
						data-testid="scan-duplicates-delete-datalake"
						class="gap-1 text-destructive"
					>
						<Trash2 class="size-3 {deleting ? 'animate-pulse' : ''}" />
						Delete {datalakeDeleteKeys.length} etag duplicate{datalakeDeleteKeys.length === 1
							? ''
							: 's'}
					</Button>
				</form>
			{/if}
		</div>
		{#if !datalake}
			<p class="mt-2 text-sm text-muted-foreground">No datalake section yet.</p>
		{:else if datalake.error}
			<p class="mt-2 text-sm text-destructive">{datalake.error}</p>
		{:else}
			{#if (datalake.identicalContentCount ?? 0) === 0 && (datalake.sameBasenameCount ?? 0) === 0}
				<p class="mt-2 text-sm text-green-600">No duplicates found.</p>
			{/if}
			{#if (datalake.identicalContentCount ?? 0) > 0}
				<p class="mt-3 text-xs font-medium text-muted-foreground">
					Byte-identical (same etag) — {datalake.identicalContentCount} group{datalake.identicalContentCount ===
					1
						? ''
						: 's'}
				</p>
				<ul class="mt-1 space-y-1">
					{#each datalake.identicalContent ?? [] as group, i (group.etag ?? i)}
						<li class="rounded bg-muted/50 px-2 py-1 font-mono text-[11px]">
							<span class="text-muted-foreground">{group.size?.toLocaleString()} B</span>
							{#each group.keys ?? [] as k, j (k)}
								{j > 0 ? ' ≡ ' : ' '}{truncate(k, 70)}
							{/each}
						</li>
					{/each}
				</ul>
			{/if}
			{#if (datalake.sameBasenameCount ?? 0) > 0}
				<p class="mt-3 text-xs font-medium text-muted-foreground">
					Same basename, different prefixes — {datalake.sameBasenameCount}
				</p>
				<ul class="mt-1 space-y-1">
					{#each datalake.sameBasename ?? [] as group, i (group.basename ?? i)}
						<li class="rounded bg-muted/50 px-2 py-1 font-mono text-[11px]">
							{group.basename}:
							{#each group.keys ?? [] as k, j (k)}
								{j > 0 ? ' | ' : ' '}{truncate(k, 70)}
							{/each}
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</section>

	<!-- 4. Layer harness -->
	<section class="rounded-lg border bg-card p-5" data-testid="scan-duplicates-harness">
		<div class="flex items-center gap-2 text-sm font-medium">
			<CopyCheck class="size-4 text-muted-foreground" />
			Layer harness (__caCfg / .vtab)
		</div>
		{#if !harness}
			<p class="mt-2 text-sm text-muted-foreground">No harness section yet.</p>
		{:else if harness.error}
			<p class="mt-2 text-sm text-destructive">{harness.error}</p>
		{:else}
			{#if (harness.cacfgDupCount ?? 0) === 0 && (harness.vtabDupCount ?? 0) === 0}
				<p class="mt-2 text-sm text-green-600">
					{harness.done ? 'No duplicates found.' : 'No duplicates in files scanned so far.'}
				</p>
			{/if}
			{#if (harness.cacfgDupCount ?? 0) > 0}
				<p class="mt-3 text-xs font-medium text-muted-foreground">
					Duplicate __caCfg keys — {harness.cacfgDupCount} file{harness.cacfgDupCount === 1
						? ''
						: 's'}
				</p>
				<ul class="mt-1 space-y-1">
					{#each harness.cacfgDupFiles ?? [] as f (f.path)}
						<li class="rounded bg-muted/50 px-2 py-1 font-mono text-[11px]">
							{f.path}
							<span class="text-destructive">
								({f.dups.map((d) => `${d.key}×${d.count}`).join(', ')})
							</span>
						</li>
					{/each}
				</ul>
			{/if}
			{#if (harness.vtabDupCount ?? 0) > 0}
				<p class="mt-3 text-xs font-medium text-muted-foreground">
					Duplicate .vtab data-view — {harness.vtabDupCount} file{harness.vtabDupCount === 1
						? ''
						: 's'}
				</p>
				<ul class="mt-1 space-y-1">
					{#each harness.vtabDupFiles ?? [] as f (f.path)}
						<li class="rounded bg-muted/50 px-2 py-1 font-mono text-[11px]">
							{f.path}
							<span class="text-destructive">
								({f.dups.map((d) => `${d.view}×${d.count}`).join(', ')})
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</section>

	{#if form?.action === 'deleteKeys' && form?.error}
		<p class="text-xs text-destructive" data-testid="scan-duplicates-delete-error">{form.error}</p>
	{:else if form?.action === 'deleteKeys' && form?.success}
		<p class="text-xs text-green-600" data-testid="scan-duplicates-delete-ok">
			Deleted {form.deletedCount} R2 key{form.deletedCount === 1 ? '' : 's'}.
		</p>
	{/if}
</div>
