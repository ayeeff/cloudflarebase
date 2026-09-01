<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { RefreshCw, Clock, Globe, CheckCircle2, XCircle } from '@lucide/svelte';

	let { data, form } = $props();

	const geoBase = 'https://geo-astro-site.foodstarmelbourne.workers.dev';

	let running = $state(false);

	// The freshest status: the action result after a run, otherwise the load data.
	let status = $derived(form?.status ?? data.status);
	let lastRun = $derived(status?.lastRunAt ? new Date(status.lastRunAt) : null);

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

	const maps = $derived(Object.entries(status?.maps ?? {}));
</script>

<svelte:head>
	<title>Update · Geo Admin · Cloudflarebase</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-3xl space-y-6 px-3 py-5 sm:px-6 sm:py-8">
	<div>
		<h1 class="text-2xl font-bold tracking-tight">Update</h1>
		<p class="mt-1 text-sm text-muted-foreground">
			Weekly World Bank refresh for the dataset maps (<a
				href="{geoBase}/maps/global-population"
				target="_blank"
				rel="noopener"
				class="text-blue-500 hover:underline">global-population</a
			>,
			<a
				href="{geoBase}/maps/global-gdp"
				target="_blank"
				rel="noopener"
				class="text-blue-500 hover:underline">global-gdp</a
			>). Runs on the <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">update</code>
			Worker via cron; values land in R2 and the main site merges them at request time.
		</p>
	</div>

	<section class="rounded-lg border bg-card p-5" data-testid="update-status">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div class="flex items-center gap-2 text-sm font-medium">
				<Clock class="size-4 text-muted-foreground" />
				Last run
			</div>
			{#if status?.ok === false && status?.error}
				<Badge variant="destructive" class="gap-1 text-xs" data-testid="update-error-badge">
					<XCircle class="size-3" /> failed
				</Badge>
			{:else if status?.lastRunAt}
				<Badge
					variant="outline"
					class="gap-1 border-green-600/40 text-xs text-green-600"
					data-testid="update-ok-badge"
				>
					<CheckCircle2 class="size-3" /> ok
				</Badge>
			{/if}
		</div>

		{#if status?.lastRunAt}
			<dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
				<dt class="text-muted-foreground">When</dt>
				<dd data-testid="update-last-run">
					{lastRun!.toUTCString()} <span class="text-muted-foreground">({ago})</span>
				</dd>
				<dt class="text-muted-foreground">Trigger</dt>
				<dd class="capitalize" data-testid="update-trigger">{status.trigger ?? '—'}</dd>
				<dt class="text-muted-foreground">Duration</dt>
				<dd>{status.durationMs != null ? `${(status.durationMs / 1000).toFixed(1)}s` : '—'}</dd>
				<dt class="text-muted-foreground">Cron</dt>
				<dd class="font-mono text-xs">{data.cron}</dd>
			</dl>
		{:else}
			<p class="mt-3 text-sm text-muted-foreground" data-testid="update-never-run">
				{status?.neverRun
					? 'The cron has not run yet — push the button to refresh now.'
					: `Could not read status: ${status?.error ?? 'unknown error'}`}
			</p>
		{/if}

		{#if status?.error}
			<p class="mt-2 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">
				{status.error}
			</p>
		{/if}
	</section>

	{#if maps.length}
		<section class="grid gap-3 sm:grid-cols-2">
			{#each maps as [slug, m] (slug)}
				<div class="rounded-lg border bg-card p-4">
					<div class="flex items-center gap-2 text-sm font-medium">
						<Globe class="size-4 text-muted-foreground" />
						{slug}
					</div>
					<p class="mt-1 text-xs text-muted-foreground">
						{m.countries} countries · data years {m.years}
					</p>
					<p class="mt-0.5 font-mono text-[10px] text-muted-foreground">{m.indicator}</p>
				</div>
			{/each}
		</section>
	{/if}

	<section>
		<form
			method="POST"
			action="?/run"
			use:enhance={() => {
				running = true;
				return async ({ update }) => {
					await update;
					running = false;
				};
			}}
		>
			<Button type="submit" disabled={running} data-testid="update-run-button" class="gap-2">
				<RefreshCw class="size-4 {running ? 'animate-spin' : ''}" />
				{running ? 'Refreshing…' : 'Refresh data now'}
			</Button>
			{#if form?.success === false && form?.error}
				<p class="mt-2 text-xs text-destructive" data-testid="update-run-error">{form.error}</p>
			{:else if form?.success}
				<p class="mt-2 text-xs text-green-600" data-testid="update-run-ok">
					Refreshed — World Bank data written to R2.
				</p>
			{/if}
		</form>
	</section>
</div>
