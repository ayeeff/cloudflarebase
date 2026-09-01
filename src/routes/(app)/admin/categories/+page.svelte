<script lang="ts">
	import * as Table from '$lib/components/ui/table';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { enhance } from '$app/forms';

	// load() on this route only throws a redirect to /dashboard/geo-site/content/categories,
	// so generated PageData is never — annotate to keep svelte-check quiet for
	// this legacy (unreachable) UI.
	let { data, form }: { data: any; form: any } = $props();

	let editingUuid = $state<string | null>(null);

	const base = data.base ?? 'https://geo-astro-site.foodstarmelbourne.workers.dev';
</script>

<svelte:head>
	<title>Categories · Geo Admin · Cloudflarebase</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-6xl space-y-6 px-3 py-5 sm:px-6 sm:py-8">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold tracking-tight">Categories</h1>
			<p class="text-sm text-muted-foreground">{data.count} neighborhood categories</p>
		</div>
	</div>

	{#if form?.error}
		<p
			class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
		>
			{form.error}
		</p>
	{/if}
	{#if form?.success}
		<p
			class="rounded-md border border-green-500/40 bg-green-500/10 px-3 py-2 text-sm text-green-600"
		>
			Action succeeded. Category changes are build-time — a redeploy is required for them to take
			effect on the live site.
		</p>
	{/if}

	<div
		class="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700"
	>
		Add / Edit / Delete write to the geo-astro-site filesystem and only succeed in a local/dev
		deployment. On the live Worker they return “admin write unavailable”. Run them locally, then
		redeploy. The list below is always live (read-only).
	</div>

	<form method="POST" action="?/add" use:enhance class="space-y-2 rounded-lg border p-4">
		<h2 class="text-sm font-semibold">Add categories</h2>
		<p class="text-xs text-muted-foreground">One per line: <code>group | label</code> (max 10).</p>
		<textarea
			name="input"
			rows="4"
			class="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
			placeholder="fitness|Fitness & Health
tech|Tech & Gadgets"
		></textarea>
		<Button type="submit" size="sm">Add</Button>
	</form>

	<div class="rounded-lg border">
		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head class="w-[80px]">UUID</Table.Head>
					<Table.Head>Group</Table.Head>
					<Table.Head>Label</Table.Head>
					<Table.Head class="w-[200px]">Actions</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each data.categories as cat (cat.uuid)}
					<Table.Row>
						<Table.Cell class="font-mono text-xs">{cat.uuid}</Table.Cell>
						<Table.Cell class="font-medium">{cat.group}</Table.Cell>
						<Table.Cell>{cat.label}</Table.Cell>
						<Table.Cell>
							{#if editingUuid === cat.uuid}
								<form method="POST" action="?/edit" use:enhance class="flex flex-col gap-1">
									<input type="hidden" name="uuid" value={cat.uuid} />
									<input
										name="newGroup"
										placeholder="new group"
										value={cat.group}
										class="rounded border border-border px-2 py-1 text-xs"
									/>
									<input
										name="newLabel"
										placeholder="new label"
										value={cat.label}
										class="rounded border border-border px-2 py-1 text-xs"
									/>
									<div class="flex gap-1">
										<Button size="sm" type="submit">Save</Button>
										<Button
											size="sm"
											variant="ghost"
											type="button"
											onclick={() => (editingUuid = null)}
										>
											Cancel
										</Button>
									</div>
								</form>
							{:else}
								<div class="flex gap-1">
									<Button
										size="sm"
										variant="outline"
										type="button"
										onclick={() => (editingUuid = cat.uuid)}
									>
										Edit
									</Button>
									<form method="POST" action="?/delete" use:enhance>
										<input type="hidden" name="uuid" value={cat.uuid} />
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
