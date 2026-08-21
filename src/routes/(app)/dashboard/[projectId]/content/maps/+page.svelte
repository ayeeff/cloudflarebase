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
