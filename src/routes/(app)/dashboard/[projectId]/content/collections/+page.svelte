<script lang="ts">
	import * as Table from '$lib/components/ui/table';
	import * as Tabs from '$lib/components/ui/tabs';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	let labels: string[] = $derived(data.labels ?? Object.keys(data.collections));
	let activeTab = $state<string>('');
	// Start on the first non-empty collection tab.
	$effect(() => {
		if (!activeTab && labels.length) {
			activeTab = labels.find((l) => (data.collections[l]?.length ?? 0) > 0) ?? labels[0];
		}
	});

	let addSlug = $state('');
	let addName = $state('');
	let addIata = $state('');

	let editingKey = $state<string | null>(null);
	let editName = $state('');
	let editIata = $state('');
	let editPop = $state('');
	let editContinent = $state('');

	function total(): number {
		return labels.reduce((n, l) => n + (data.collections[l]?.length ?? 0), 0);
	}
</script>

<svelte:head>
	<title>Collections · Geo Admin · Cloudflarebase</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-6xl space-y-6 px-3 py-5 sm:px-6 sm:py-8">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold tracking-tight">Collections</h1>
			<p class="text-sm text-muted-foreground">
				{total()} maps &amp; atlases across {labels.length} collections — add, edit or remove members.
			</p>
		</div>
		<div class="flex items-center gap-2">
			<Badge variant={data.overridden ? 'default' : 'secondary'}>
				{data.overridden ? 'R2 override live' : 'build seed'}
			</Badge>
			{#if data.overridden}
				<form method="POST" action="?/reset" use:enhance>
					<Button size="sm" variant="outline" type="submit">Reset to seed</Button>
				</form>
			{/if}
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
		<input type="hidden" name="collection" value={activeTab || labels[0]} />
		<div class="w-[180px]">
			<label class="mb-1 block text-xs font-medium text-muted-foreground" for="add-collection">Collection</label>
			<select
				id="add-collection"
				bind:value={activeTab}
				class="h-9 w-full rounded-md border bg-background px-2 text-sm">
				{#each labels as l (l)}
					<option value={l}>{l} ({data.collections[l]?.length ?? 0})</option>
				{/each}
			</select>
		</div>
		<div class="flex-1">
			<label class="mb-1 block text-xs font-medium text-muted-foreground" for="add-slug">Map / atlas slug</label>
			<Input id="add-slug" name="slug" list="picker-slugs" bind:value={addSlug} placeholder="athens-city-atlas" class="font-mono text-xs" required />
			<datalist id="picker-slugs">
				{#each data.picker as p (p.slug)}
					<option value={p.slug}>{p.isAtlas ? 'Atlas' : 'Map'} — {p.title}</option>
				{/each}
			</datalist>
		</div>
		<div class="w-[160px]">
			<label class="mb-1 block text-xs font-medium text-muted-foreground" for="add-name">Name (optional)</label>
			<Input id="add-name" name="name" bind:value={addName} placeholder="Athens" class="text-xs" />
		</div>
		<div class="w-[90px]">
			<label class="mb-1 block text-xs font-medium text-muted-foreground" for="add-iata">IATA</label>
			<Input id="add-iata" name="iata" bind:value={addIata} placeholder="ATH" class="font-mono text-xs uppercase" />
		</div>
		<Button type="submit">Add to collection</Button>
	</form>

	<Tabs.Root bind:value={activeTab}>
		<Tabs.List class="mb-4 flex-wrap">
			{#each labels as l (l)}
				<Tabs.Trigger value={l}>{l} ({data.collections[l]?.length ?? 0})</Tabs.Trigger>
			{/each}
		</Tabs.List>

		{#each labels as l (l)}
			<Tabs.Content value={l}>
				<div class="rounded-lg border">
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>Slug</Table.Head>
								<Table.Head>Name</Table.Head>
								<Table.Head class="w-[70px]">IATA</Table.Head>
								<Table.Head class="w-[100px]">Pop</Table.Head>
								<Table.Head class="w-[110px]">Continent</Table.Head>
								<Table.Head class="w-[170px]">Actions</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each data.collections[l] ?? [] as r (r.slug)}
								<Table.Row>
									<Table.Cell class="font-mono text-[11px]">{r.slug}</Table.Cell>
									<Table.Cell class="font-medium">{r.name}</Table.Cell>
									<Table.Cell class="font-mono text-xs">{r.iata}</Table.Cell>
									<Table.Cell class="text-xs">{r.pop ?? '—'}</Table.Cell>
									<Table.Cell class="text-xs">{r.continent ?? '—'}</Table.Cell>
									<Table.Cell>
										{#if editingKey === `${l}/${r.slug}`}
											<form method="POST" action="?/edit" use:enhance class="flex flex-col gap-1">
												<input type="hidden" name="collection" value={l} />
												<input type="hidden" name="slug" value={r.slug} />
												<div class="flex gap-1">
													<Input name="name" bind:value={editName} class="h-7 w-28 text-xs" />
													<Input name="iata" bind:value={editIata} class="h-7 w-16 font-mono text-xs uppercase" />
													<Input name="pop" bind:value={editPop} type="number" class="h-7 w-20 text-xs" />
													<Input name="continent" bind:value={editContinent} class="h-7 w-24 text-xs" />
												</div>
												<div class="flex gap-1">
													<Button size="sm" type="submit">Save</Button>
													<Button size="sm" variant="ghost" type="button" onclick={() => (editingKey = null)}>Cancel</Button>
												</div>
											</form>
										{:else}
											<div class="flex gap-1">
												<Button
													size="sm"
													variant="outline"
													type="button"
													onclick={() => {
														editingKey = `${l}/${r.slug}`;
														editName = r.name ?? '';
														editIata = r.iata ?? '';
														editPop = r.pop != null ? String(r.pop) : '';
														editContinent = r.continent ?? '';
													}}>Edit</Button>
												<Button size="sm" variant="ghost" type="button" onclick={() => window.open(`${data.base}/atlas/${r.slug}`, '_blank')}>
													View
												</Button>
												<form method="POST" action="?/remove" use:enhance>
													<input type="hidden" name="collection" value={l} />
													<input type="hidden" name="slug" value={r.slug} />
													<Button size="sm" variant="destructive" type="submit">Remove</Button>
												</form>
											</div>
										{/if}
									</Table.Cell>
								</Table.Row>
							{/each}
							{#if (data.collections[l]?.length ?? 0) === 0}
								<Table.Row>
									<Table.Cell colspan={6} class="py-6 text-center text-sm text-muted-foreground">
										No maps or atlases in this collection yet.
									</Table.Cell>
								</Table.Row>
							{/if}
						</Table.Body>
					</Table.Root>
				</div>
			</Tabs.Content>
		{/each}
	</Tabs.Root>
</div>
