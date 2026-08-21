<script lang="ts">
	import * as Table from '$lib/components/ui/table';
	import { Badge } from '$lib/components/ui/badge';

	let { data } = $props();
</script>

<svelte:head>
	<title>Templates · Geo Admin · Cloudflarebase</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-6xl space-y-6 px-3 py-5 sm:px-6 sm:py-8">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold tracking-tight">Templates</h1>
			<p class="text-sm text-muted-foreground">{data.count} category templates (redesign via /addtemplate)</p>
		</div>
	</div>

	<div class="rounded-lg border">
		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head class="w-[80px]">UUID</Table.Head>
					<Table.Head>Group</Table.Head>
					<Table.Head>Label</Table.Head>
					<Table.Head>Folder</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each data.categories as cat}
					<Table.Row>
						<Table.Cell class="font-mono text-xs">{cat.uuid}</Table.Cell>
						<Table.Cell class="font-medium">{cat.group}</Table.Cell>
						<Table.Cell>{cat.label}</Table.Cell>
						<Table.Cell class="font-mono text-xs text-muted-foreground">{cat.folder}</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</div>
</div>
