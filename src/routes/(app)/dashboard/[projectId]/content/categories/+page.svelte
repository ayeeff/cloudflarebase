<script lang="ts">
	import * as Table from '$lib/components/ui/table';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	let addInput = $state('');
	let editingUuid = $state<string | null>(null);
	let editGroup = $state('');
	let editLabel = $state('');
</script>

<svelte:head>
	<title>Categories · Geo Admin · Cloudflarebase</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-6xl space-y-6 px-3 py-5 sm:px-6 sm:py-8">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold tracking-tight">Categories</h1>
			<p class="text-sm text-muted-foreground">
				{data.count} categories — edit labels/groups, delete, or batch-add.
			</p>
		</div>
	</div>

	{#if (form as any)?.error}
		<p class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
			{(form as any).error}
		</p>
	{/if}
	{#if (form as any)?.success}
		<p class="rounded-md border border-emerald-400/40 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-600">
			Action succeeded.
		</p>
	{/if}

	<form method="POST" action="?/add" use:enhance class="flex flex-col gap-2 rounded-lg border p-4 sm:flex-row sm:items-end">
		<div class="flex-1">
			<label class="mb-1 block text-xs font-medium text-muted-foreground">
				Batch add (one per line: label | group)
			</label>
			<textarea
				bind:value={addInput}
				rows="2"
				class="w-full rounded-md border bg-background px-2 py-1 font-mono text-xs"
				placeholder="Coffee | beverage&#10;Tea | beverage"></textarea>
		</div>
		<Button type="submit">Add categories</Button>
	</form>

	<div class="rounded-lg border">
		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head class="w-[60px]">UUID</Table.Head>
					<Table.Head>Label</Table.Head>
					<Table.Head class="w-[120px]">Group</Table.Head>
					<Table.Head class="w-[60px]">cat</Table.Head>
					<Table.Head class="w-[60px]">articles</Table.Head>
					<Table.Head class="w-[60px]">tumblr</Table.Head>
					<Table.Head class="w-[160px]">Actions</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each data.categories as c (c.uuid)}
					<Table.Row>
						<Table.Cell class="font-mono text-[10px]">{c.uuid}</Table.Cell>
						<Table.Cell class="font-medium">{c.label}</Table.Cell>
						<Table.Cell class="font-mono text-xs">{c.group}</Table.Cell>
						<Table.Cell><Badge variant={c.hasCat ? 'default' : 'secondary'}>{c.hasCat ? 'Y' : 'N'}</Badge></Table.Cell>
						<Table.Cell><Badge variant={c.hasArticles ? 'default' : 'secondary'}>{c.hasArticles ? 'Y' : 'N'}</Badge></Table.Cell>
						<Table.Cell><Badge variant={c.hasTumblr ? 'default' : 'secondary'}>{c.hasTumblr ? 'Y' : 'N'}</Badge></Table.Cell>
						<Table.Cell class="space-y-1">
							{#if editingUuid === c.uuid}
								<form method="POST" action="?/edit" use:enhance class="flex flex-col gap-1">
									<input type="hidden" name="uuid" value={c.uuid} />
									<Input name="newLabel" placeholder="new label" bind:value={editLabel} class="h-7 text-xs" />
									<Input name="newGroup" placeholder="new group" bind:value={editGroup} class="h-7 text-xs" />
									<div class="flex gap-1">
										<Button size="sm" type="submit">Save</Button>
										<Button size="sm" variant="ghost" type="button" onclick={() => (editingUuid = null)}>Cancel</Button>
									</div>
								</form>
							{:else}
								<div class="flex gap-1">
									<Button
										size="sm"
										variant="outline"
										type="button"
										onclick={() => {
											editingUuid = c.uuid;
											editLabel = c.label;
											editGroup = c.group;
										}}>Edit</Button>
									<form method="POST" action="?/delete" use:enhance>
										<input type="hidden" name="uuid" value={c.uuid} />
										<Button size="sm" variant="destructive" type="submit">Delete</Button>
									</form>
								</div>
							{/if}
						</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</div>
</div>
