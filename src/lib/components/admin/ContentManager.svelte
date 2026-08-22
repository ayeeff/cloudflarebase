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

	// ── Sorting ──
	type SortKey = 'slug' | 'title' | 'views' | 'likes' | 'comments';
	let sortKey = $state<SortKey | ''>('');
	let sortDir = $state<'asc' | 'desc'>('desc');

	function toggleSort(key: SortKey) {
		if (sortKey === key) {
			sortDir = sortDir === 'asc' ? 'desc' : 'asc';
		} else {
			sortKey = key;
			sortDir = key === 'slug' || key === 'title' ? 'asc' : 'desc';
		}
		page = 1;
	}

	const sortedRows = $derived.by(() => {
		if (!sortKey) return data.rows;
		const dir = sortDir === 'asc' ? 1 : -1;
		return [...data.rows].sort((a: any, b: any) => {
			let av: any = a[sortKey];
			let bv: any = b[sortKey];
			if (typeof av === 'string' || typeof bv === 'string') {
				return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
			}
			av = Number(av) || 0;
			bv = Number(bv) || 0;
			return (av - bv) * dir;
		});
	});

	// ── Pagination (50 / page) ──
	const PER_PAGE = 50;
	let page = $state(1);
	const totalPages = $derived(Math.max(1, Math.ceil(sortedRows.length / PER_PAGE)));
	const pageRows = $derived(sortedRows.slice((page - 1) * PER_PAGE, page * PER_PAGE));

	function gotoPage(p: number) {
		page = Math.min(totalPages, Math.max(1, p));
	}

	function caret(key: SortKey): string {
		if (sortKey !== key) return '';
		return sortDir === 'asc' ? ' ▲' : ' ▼';
	}

	function sortableHead(key: SortKey, label: string): string {
		return label + caret(key);
	}
</script>

<svelte:head>
	<title>{title} · Geo Admin · Cloudflarebase</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-full space-y-6 px-3 py-5 sm:px-6 sm:py-8">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold tracking-tight">{title}</h1>
			<p class="text-sm text-muted-foreground">
				{data.count} {title.toLowerCase()} · {data.deniedCount} hidden
			</p>
		</div>
		{#if totalPages > 1}
			<p class="text-xs text-muted-foreground">
				Page {page} / {totalPages}
			</p>
		{/if}
	</div>

	{#if form?.error}
		<p class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
			{form.error}
		</p>
	{/if}

	<div class="rounded-lg border">
		<Table.Root class="w-full table-fixed">
			<Table.Header>
				<Table.Row>
					<Table.Head class="w-[20%] cursor-pointer select-none" onclick={() => toggleSort('slug')}>{sortableHead('slug', 'Slug')}</Table.Head>
					<Table.Head class="w-[28%] cursor-pointer select-none" onclick={() => toggleSort('title')}>{sortableHead('title', 'Title')}</Table.Head>
					<Table.Head class="w-[72px] cursor-pointer select-none text-right" onclick={() => toggleSort('views')}>{sortableHead('views', 'Views')}</Table.Head>
					<Table.Head class="w-[72px] cursor-pointer select-none text-right" onclick={() => toggleSort('likes')}>{sortableHead('likes', 'Likes')}</Table.Head>
					<Table.Head class="w-[88px] cursor-pointer select-none text-right" onclick={() => toggleSort('comments')}>{sortableHead('comments', 'Comments')}</Table.Head>
					{#if !isArticle}<Table.Head class="w-[92px]">UUID</Table.Head>{/if}
					<Table.Head class="w-[110px]">Actions</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each pageRows as row (row.pathKey)}
					<Table.Row class={row.denied ? 'opacity-60' : ''}>
						<Table.Cell class="truncate font-mono text-xs">
							<div class="flex items-center gap-1 truncate">
								<a href={rowUrl(row)} class="truncate text-blue-500 hover:underline" target="_blank" rel="noopener">
									{row.slug}
								</a>
								{#if row.denied}
									<Badge variant="destructive" class="ml-1 shrink-0 text-[10px]">hidden</Badge>
								{/if}
							</div>
						</Table.Cell>
						<Table.Cell class="truncate font-medium">{row.title || row.slug}</Table.Cell>
						<Table.Cell class="text-right tabular-nums">{row.views}</Table.Cell>
						<Table.Cell class="text-right tabular-nums">{row.likes}</Table.Cell>
						<Table.Cell class="text-right tabular-nums">{row.comments}</Table.Cell>
						{#if !isArticle}
							<Table.Cell class="truncate font-mono text-xs">{row.uuid || '—'}</Table.Cell>
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
									<Button size="sm" variant="destructive" type="submit">Delete</Button>
								</form>
							{/if}
						</Table.Cell>
					</Table.Row>
				{/each}
				{#if pageRows.length === 0}
					<Table.Row>
						<Table.Cell colspan={isArticle ? 6 : 7} class="py-8 text-center text-sm text-muted-foreground">
							No {title.toLowerCase()} found.
						</Table.Cell>
					</Table.Row>
				{/if}
			</Table.Body>
		</Table.Root>
	</div>

	{#if totalPages > 1}
		<div class="flex items-center justify-center gap-2">
			<Button size="sm" variant="outline" type="button" onclick={() => gotoPage(page - 1)} disabled={page <= 1}>Prev</Button>
			<span class="text-sm text-muted-foreground">Page {page} of {totalPages}</span>
			<Button size="sm" variant="outline" type="button" onclick={() => gotoPage(page + 1)} disabled={page >= totalPages}>Next</Button>
		</div>
	{/if}

	{#if data.deniedCount > 0}
		<div class="rounded-lg border border-dashed">
			<div class="border-b px-4 py-3">
				<h2 class="text-sm font-semibold">Hidden {title.toLowerCase()} (denylist)</h2>
				<p class="text-xs text-muted-foreground">
					These return 404 on the live site until restored.
				</p>
			</div>
			<Table.Root class="w-full table-fixed">
				<Table.Header>
					<Table.Row>
						<Table.Head>Path</Table.Head>
						<Table.Head class="w-[160px]">Denied at</Table.Head>
						<Table.Head class="w-[120px]">Actions</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.denied as d (d.key ?? d.slug)}
						<Table.Row>
							<Table.Cell class="truncate font-mono text-xs">{d.key ?? d.slug}</Table.Cell>
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
