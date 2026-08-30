<script lang="ts">
	import * as Table from '$lib/components/ui/table';
	import * as Tabs from '$lib/components/ui/tabs';
	import { Button } from '$lib/components/ui/button';
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	let mapRings = $derived(data.rings.filter((r: any) => r.kind === 'map'));
	let categoryRings = $derived(data.rings.filter((r: any) => r.kind === 'category'));
</script>

<svelte:head>
	<title>Webrings · Geo Admin · Cloudflarebase</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-6xl space-y-6 px-3 py-5 sm:px-6 sm:py-8">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold tracking-tight">Webrings</h1>
			<p class="text-sm text-muted-foreground">
				{mapRings.length} map rings (IATA) · {categoryRings.length} category rings — view or delete.
			</p>
		</div>
		<form method="POST" action="?/backfillNames" use:enhance>
			<Button size="sm" variant="outline" type="submit">Backfill missing names</Button>
		</form>
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

	<Tabs.Root value="map">
		<Tabs.List class="mb-4">
			<Tabs.Trigger value="map">Map webrings ({mapRings.length})</Tabs.Trigger>
			<Tabs.Trigger value="category">Category webrings ({categoryRings.length})</Tabs.Trigger>
		</Tabs.List>

		<Tabs.Content value="map">
			<div class="rounded-lg border">
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head class="w-[90px]">UUID</Table.Head>
							<Table.Head>Name</Table.Head>
							<Table.Head>City</Table.Head>
							<Table.Head class="w-[80px]">Maps</Table.Head>
							<Table.Head class="w-[80px]">Members</Table.Head>
							<Table.Head class="w-[80px]">Pending</Table.Head>
							<Table.Head class="w-[150px]">Actions</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each mapRings as r (r.uuid)}
							<Table.Row>
								<Table.Cell class="font-mono text-[10px]">{r.uuid}</Table.Cell>
								<Table.Cell class="font-medium">{r.name}</Table.Cell>
								<Table.Cell class="text-xs">
									{r.municipality} <span class="font-mono text-muted-foreground">({r.iata})</span>
								</Table.Cell>
								<Table.Cell>{r.entryCount}</Table.Cell>
								<Table.Cell>{r.memberCount}</Table.Cell>
								<Table.Cell>{r.pendingCount}</Table.Cell>
								<Table.Cell>
									<div class="flex gap-1">
										<Button size="sm" variant="outline" type="button" onclick={() => window.open(`${data.base}/webring/${r.uuid}`, '_blank')}>
											View
										</Button>
										<form method="POST" action="?/delete" use:enhance>
											<input type="hidden" name="uuid" value={r.uuid} />
											<Button size="sm" variant="destructive" type="submit">Delete</Button>
										</form>
									</div>
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</div>
		</Tabs.Content>

		<Tabs.Content value="category">
			<div class="rounded-lg border">
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head class="w-[90px]">UUID</Table.Head>
							<Table.Head>Name</Table.Head>
							<Table.Head>Category</Table.Head>
							<Table.Head class="w-[80px]">Posts</Table.Head>
							<Table.Head class="w-[80px]">Members</Table.Head>
							<Table.Head class="w-[80px]">Pending</Table.Head>
							<Table.Head class="w-[150px]">Actions</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each categoryRings as r (r.uuid)}
							<Table.Row>
								<Table.Cell class="font-mono text-[10px]">{r.uuid}</Table.Cell>
								<Table.Cell class="font-medium">{r.name}</Table.Cell>
								<Table.Cell class="text-xs">
									{r.group} <span class="font-mono text-muted-foreground">({r.categoryUuid})</span>
								</Table.Cell>
								<Table.Cell>{r.entryCount}</Table.Cell>
								<Table.Cell>{r.memberCount}</Table.Cell>
								<Table.Cell>{r.pendingCount}</Table.Cell>
								<Table.Cell>
									<div class="flex gap-1">
										<Button size="sm" variant="outline" type="button" onclick={() => window.open(`${data.base}/webring/${r.uuid}`, '_blank')}>
											View
										</Button>
										<form method="POST" action="?/delete" use:enhance>
											<input type="hidden" name="uuid" value={r.uuid} />
											<Button size="sm" variant="destructive" type="submit">Delete</Button>
										</form>
									</div>
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</div>
		</Tabs.Content>
	</Tabs.Root>
</div>
