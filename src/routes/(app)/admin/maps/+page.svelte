<script lang="ts">
	import * as Table from '$lib/components/ui/table';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { enhance } from '$app/forms';

	// load() on this route only throws a redirect to /dashboard/geo-site/content/maps,
	// so generated PageData is never — annotate to keep svelte-check quiet for
	// this legacy (unreachable) UI.
	let { data, form }: { data: any; form: any } = $props();

	const base = data.base ?? 'https://geo-astro-site.foodstarmelbourne.workers.dev';

	function shotUrl(map: any): string | null {
		return map.screenshotUrl ?? null;
	}
</script>

<svelte:head>
	<title>Maps · Geo Admin · Cloudflarebase</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-6xl space-y-6 px-3 py-5 sm:px-6 sm:py-8">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold tracking-tight">Maps</h1>
			<p class="text-sm text-muted-foreground">
				{data.count} generated maps · {data.deniedCount} hidden
			</p>
		</div>
	</div>

	{#if (form as any)?.error}
		<p class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
			{(form as any).error}
		</p>
	{/if}

	<div class="rounded-lg border">
		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head class="w-[80px]">Screenshot</Table.Head>
					<Table.Head>Slug</Table.Head>
					<Table.Head>Title</Table.Head>
					<Table.Head class="w-[80px]">UUID</Table.Head>
					<Table.Head class="w-[60px]">Type</Table.Head>
					<Table.Head class="w-[80px]">Data</Table.Head>
					<Table.Head class="w-[120px]">Actions</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each data.maps as map (map.pathKey)}
					<Table.Row class={map.denied ? 'opacity-60' : ''}>
						<Table.Cell>
							{#if shotUrl(map)}
								<img
									src={shotUrl(map)}
									alt={map.slug}
									class="h-12 w-20 rounded border object-cover"
									loading="lazy"
								/>
							{:else}
								<span class="text-xs text-muted-foreground">—</span>
							{/if}
						</Table.Cell>
						<Table.Cell class="font-mono text-xs">
							<a
								href="{base}/maps/{map.uuid ? map.uuid + '/' : ''}{map.slug}"
								class="text-blue-500 hover:underline"
								target="_blank"
								rel="noopener">{map.slug}</a>
							{#if map.denied}
								<Badge variant="destructive" class="ml-1 text-[10px]">hidden</Badge>
							{/if}
						</Table.Cell>
						<Table.Cell class="font-medium">{map.title || map.slug}</Table.Cell>
						<Table.Cell class="font-mono text-xs">{map.uuid || '—'}</Table.Cell>
						<Table.Cell>
							<Badge variant="secondary">{map.type || 'flat'}</Badge>
						</Table.Cell>
						<Table.Cell>
							{#if map.hasDataJson}
								<Badge variant="default" class="text-xs">Yes</Badge>
							{:else}
								<span class="text-xs text-muted-foreground">No</span>
							{/if}
						</Table.Cell>
						<Table.Cell>
							{#if map.denied}
								<form method="POST" action="?/restore" use:enhance>
									<input type="hidden" name="slug" value={map.slug} />
									{#if map.uuid}<input type="hidden" name="uuid" value={map.uuid} />{/if}
									<Button size="sm" variant="outline" type="submit">Restore</Button>
								</form>
							{:else}
								<form method="POST" action="?/delete" use:enhance>
									<input type="hidden" name="slug" value={map.slug} />
									{#if map.uuid}<input type="hidden" name="uuid" value={map.uuid} />{/if}
									<Button size="sm" variant="destructive" type="submit">Hide</Button>
								</form>
							{/if}
						</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</div>

	{#if data.deniedCount > 0}
		<div class="rounded-lg border border-dashed">
			<div class="border-b px-4 py-3">
				<h2 class="text-sm font-semibold">Hidden maps (denylist)</h2>
				<p class="text-xs text-muted-foreground">
					These return 404 on the live site until restored.
				</p>
			</div>
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>Path</Table.Head>
						<Table.Head class="w-[180px]">Denied at</Table.Head>
						<Table.Head class="w-[120px]">Actions</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.denied as d (d.key)}
						<Table.Row>
							<Table.Cell class="font-mono text-xs">{d.key}</Table.Cell>
							<Table.Cell class="text-xs text-muted-foreground">
								{d.deniedAt ? new Date(d.deniedAt).toLocaleString() : '—'}
							</Table.Cell>
							<Table.Cell>
								<form method="POST" action="?/restore" use:enhance>
									<input type="hidden" name="slug" value={d.slug} />
									{#if d.uuid}<input type="hidden" name="uuid" value={d.uuid} />{/if}
									<Button size="sm" variant="outline" type="submit">Restore</Button>
								</form>
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
	{/if}
</div>
