<script lang="ts">
	import * as Table from '$lib/components/ui/table';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { enhance } from '$app/forms';

	let { data, form, title }: { data: any; form?: any; title: string } = $props();

	const base = data.base ?? 'https://geo-astro-site.foodstarmelbourne.workers.dev';
	const isArticle = data.type === 'article';

	function rowUrl(row: any): string {
		return `${base}${row.url}`;
	}
</script>

<svelte:head>
	<title>{title} · Geo Admin · Cloudflarebase</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-6xl space-y-6 px-3 py-5 sm:px-6 sm:py-8">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold tracking-tight">{title}</h1>
			<p class="text-sm text-muted-foreground">
				{data.count} {title.toLowerCase()} · {data.deniedCount} hidden
			</p>
		</div>
	</div>

	{#if form?.error}
		<p class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
			{form.error}
		</p>
	{/if}

	<div class="rounded-lg border">
		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head>Slug</Table.Head>
					<Table.Head>Title</Table.Head>
					{#if !isArticle}<Table.Head class="w-[80px]">UUID</Table.Head>{/if}
					<Table.Head class="w-[120px]">Actions</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each data.rows as row (row.pathKey)}
					<Table.Row class={row.denied ? 'opacity-60' : ''}>
						<Table.Cell class="font-mono text-xs">
							<a href={rowUrl(row)} class="text-blue-500 hover:underline" target="_blank" rel="noopener">
								{row.slug}
							</a>
							{#if row.denied}
								<Badge variant="destructive" class="ml-1 text-[10px]">hidden</Badge>
							{/if}
						</Table.Cell>
						<Table.Cell class="font-medium">{row.title || row.slug}</Table.Cell>
						{#if !isArticle}
							<Table.Cell class="font-mono text-xs">{row.uuid || '—'}</Table.Cell>
						{/if}
						<Table.Cell>
							{#if row.denied}
								<form method="POST" action="?/restore" use:enhance>
									<input type="hidden" name="slug" value={row.slug} />
									{#if row.uuid}<input type="hidden" name="uuid" value={row.uuid} />{/if}
									<Button size="sm" variant="outline" type="submit">Restore</Button>
								</form>
							{:else}
								<form method="POST" action="?/delete" use:enhance>
									<input type="hidden" name="slug" value={row.slug} />
									{#if row.uuid}<input type="hidden" name="uuid" value={row.uuid} />{/if}
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
				<h2 class="text-sm font-semibold">Hidden {title.toLowerCase()} (denylist)</h2>
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
					{#each data.denied as d (d.key ?? d.slug)}
						<Table.Row>
							<Table.Cell class="font-mono text-xs">{d.key ?? d.slug}</Table.Cell>
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
