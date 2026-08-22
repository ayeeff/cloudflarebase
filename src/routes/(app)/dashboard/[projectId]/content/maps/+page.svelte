<script lang="ts">
	import * as Table from '$lib/components/ui/table';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	const base = data.base ?? 'https://geo-astro-site.foodstarmelbourne.workers.dev';

	function shotUrl(map: any): string | null {
		return map.screenshotUrl ?? null;
	}

	// Confirmation dialog targets
	let hideTarget: any = $state(null);
	let deleteTarget: any = $state(null);
	let restoreTarget: any = $state(null);

	function formId(prefix: string, item: any): string {
		return `${prefix}-${item.slug}`;
	}

	function submitForm(prefix: string, item: any) {
		const el = document.getElementById(formId(prefix, item)) as HTMLFormElement | null;
		el?.requestSubmit();
	}

	// ── Sorting ──
	type SortKey = 'slug' | 'title' | 'uuid' | 'type' | 'views' | 'likes' | 'comments';
	let sortKey = $state<SortKey | ''>('');
	let sortDir = $state<'asc' | 'desc'>('desc');

	function toggleSort(key: SortKey) {
		if (sortKey === key) {
			sortDir = sortDir === 'asc' ? 'desc' : 'asc';
		} else {
			sortKey = key;
			sortDir = key === 'slug' || key === 'title' || key === 'uuid' || key === 'type' ? 'asc' : 'desc';
		}
		page = 1;
	}

	const sortedMaps = $derived.by(() => {
		if (!sortKey) return data.maps;
		const dir = sortDir === 'asc' ? 1 : -1;
		return [...data.maps].sort((a: any, b: any) => {
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
	const totalPages = $derived(Math.max(1, Math.ceil(sortedMaps.length / PER_PAGE)));
	const pageMaps = $derived(sortedMaps.slice((page - 1) * PER_PAGE, page * PER_PAGE));

	function gotoPage(p: number) {
		page = Math.min(totalPages, Math.max(1, p));
	}

	function caret(key: SortKey): string {
		if (sortKey !== key) return '';
		return sortDir === 'asc' ? ' ▲' : ' ▼';
	}
</script>

<svelte:head>
	<title>Maps · Geo Admin · Cloudflarebase</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-full space-y-6 px-3 py-5 sm:px-6 sm:py-8">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold tracking-tight">Maps</h1>
			<p class="text-sm text-muted-foreground">
				{data.count} generated maps · {data.deniedCount} hidden
			</p>
		</div>
		{#if totalPages > 1}
			<p class="text-xs text-muted-foreground">Page {page} / {totalPages}</p>
		{/if}
	</div>

	{#if (form as any)?.error}
		<p class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
			{(form as any).error}
		</p>
	{/if}

	<div class="rounded-lg border">
		<Table.Root class="w-full table-fixed">
			<Table.Header>
				<Table.Row>
					<Table.Head class="w-[72px]">Screenshot</Table.Head>
					<Table.Head class="w-[18%] cursor-pointer select-none" onclick={() => toggleSort('slug')}>Slug{caret('slug')}</Table.Head>
					<Table.Head class="w-[20%] cursor-pointer select-none" onclick={() => toggleSort('title')}>Title{caret('title')}</Table.Head>
					<Table.Head class="w-[80px] cursor-pointer select-none" onclick={() => toggleSort('views')}>Views{caret('views')}</Table.Head>
					<Table.Head class="w-[68px] cursor-pointer select-none" onclick={() => toggleSort('likes')}>Likes{caret('likes')}</Table.Head>
					<Table.Head class="w-[84px] cursor-pointer select-none" onclick={() => toggleSort('comments')}>Comments{caret('comments')}</Table.Head>
					<Table.Head class="w-[80px] cursor-pointer select-none" onclick={() => toggleSort('uuid')}>UUID{caret('uuid')}</Table.Head>
					<Table.Head class="w-[64px] cursor-pointer select-none" onclick={() => toggleSort('type')}>Type{caret('type')}</Table.Head>
					<Table.Head class="w-[56px]">Data</Table.Head>
					<Table.Head class="w-[150px]">Actions</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each pageMaps as map (map.pathKey)}
					<Table.Row class={map.denied ? 'opacity-60' : ''}>
						<Table.Cell>
							{#if shotUrl(map)}
								<img
									src={shotUrl(map)}
									alt={map.slug}
									class="h-10 w-[56px] rounded border object-cover"
									loading="lazy"
								/>
							{:else}
								<span class="text-xs text-muted-foreground">—</span>
							{/if}
						</Table.Cell>
						<Table.Cell class="font-mono text-xs">
							<div class="flex items-center gap-1 truncate">
								<a
									href="{base}/maps/{map.uuid ? map.uuid + '/' : ''}{map.slug}"
									class="truncate text-blue-500 hover:underline"
									target="_blank"
									rel="noopener">{map.slug}</a>
								{#if map.denied}
									<Badge variant="destructive" class="ml-1 shrink-0 text-[10px]">hidden</Badge>
								{/if}
							</div>
						</Table.Cell>
						<Table.Cell class="truncate font-medium">{map.title || map.slug}</Table.Cell>
						<Table.Cell class="text-right tabular-nums">{map.views}</Table.Cell>
						<Table.Cell class="text-right tabular-nums">{map.likes}</Table.Cell>
						<Table.Cell class="text-right tabular-nums">{map.comments}</Table.Cell>
						<Table.Cell class="truncate font-mono text-xs">{map.uuid || '—'}</Table.Cell>
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
								<form id={formId('restore', map)} method="POST" action="?/restore" use:enhance class="hidden">
									<input type="hidden" name="slug" value={map.slug} />
									{#if map.uuid}<input type="hidden" name="uuid" value={map.uuid} />{/if}
								</form>
								<Button size="sm" variant="outline" type="button" onclick={() => (restoreTarget = map)}>Restore</Button>
							{:else}
								<form id={formId('hide', map)} method="POST" action="?/delete" use:enhance class="hidden">
									<input type="hidden" name="slug" value={map.slug} />
									{#if map.uuid}<input type="hidden" name="uuid" value={map.uuid} />{/if}
								</form>
								<form id={formId('del', map)} method="POST" action="?/delete-permanent" use:enhance class="hidden">
									<input type="hidden" name="slug" value={map.slug} />
									{#if map.uuid}<input type="hidden" name="uuid" value={map.uuid} />{/if}
								</form>
								<div class="flex gap-1">
									<Button size="sm" variant="outline" type="button" onclick={() => (hideTarget = map)}>Hide</Button>
									<Button size="sm" variant="destructive" type="button" onclick={() => (deleteTarget = map)} data-testid="delete-{map.slug}">Delete</Button>
								</div>
							{/if}
						</Table.Cell>
					</Table.Row>
				{/each}
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
				<h2 class="text-sm font-semibold">Hidden maps (denylist)</h2>
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
					{#each data.denied as d (d.key)}
						<Table.Row>
							<Table.Cell class="truncate font-mono text-xs">{d.key}</Table.Cell>
							<Table.Cell class="text-xs text-muted-foreground">
								{d.deniedAt ? new Date(d.deniedAt).toLocaleString() : '—'}
							</Table.Cell>
							<Table.Cell>
								<form id={formId('restore-denied', d)} method="POST" action="?/restore" use:enhance class="hidden">
									<input type="hidden" name="slug" value={d.slug} />
									{#if d.uuid}<input type="hidden" name="uuid" value={d.uuid} />{/if}
								</form>
								<Button size="sm" variant="outline" type="button" onclick={() => (restoreTarget = d)}>Restore</Button>
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
	{/if}
</div>

<!-- Confirm: Hide (reversible denylist) -->
<AlertDialog.Root open={!!hideTarget} onOpenChange={(o) => !o && (hideTarget = null)}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Hide “{hideTarget?.slug}”?</AlertDialog.Title>
			<AlertDialog.Description>
				The map will return 404 on the live site until restored. This is reversible from the
				hidden list below.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				onclick={() => submitForm('hide', hideTarget)}
				data-testid="confirm-hide">Hide</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<!-- Confirm: Delete (permanent filesystem removal) -->
<AlertDialog.Root open={!!deleteTarget} onOpenChange={(o) => !o && (deleteTarget = null)}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Permanently delete “{deleteTarget?.slug}”?</AlertDialog.Title>
			<AlertDialog.Description>
				This removes the map's page, data and screenshot files. On Cloudflare Workers this
				requires filesystem access and only works from a local dev checkout — if it fails here,
				use <span class="font-medium">Hide</span> instead, or delete in dev.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				variant="destructive"
				onclick={() => submitForm('del', deleteTarget)}
				data-testid="confirm-delete">Delete</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<!-- Confirm: Restore -->
<AlertDialog.Root open={!!restoreTarget} onOpenChange={(o) => !o && (restoreTarget = null)}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Restore “{restoreTarget?.slug}”?</AlertDialog.Title>
			<AlertDialog.Description>
				The map will be removed from the denylist and live again on the site.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				onclick={() => submitForm(restoreTarget && restoreTarget.deniedAt ? 'restore-denied' : 'restore', restoreTarget)}
				data-testid="confirm-restore">Restore</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
