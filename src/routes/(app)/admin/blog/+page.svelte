<script lang="ts">
	import * as Table from '$lib/components/ui/table';
	import { Badge } from '$lib/components/ui/badge';

	let { data } = $props();
</script>

<svelte:head>
	<title>Blog Posts · Geo Admin · Cloudflarebase</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-6xl space-y-6 px-3 py-5 sm:px-6 sm:py-8">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold tracking-tight">Blog Posts</h1>
			<p class="text-sm text-muted-foreground">{data.count} tumblr-style blog posts</p>
		</div>
	</div>

	<div class="rounded-lg border">
		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head>Slug</Table.Head>
					<Table.Head>Title</Table.Head>
					<Table.Head class="w-[80px]">UUID</Table.Head>
					<Table.Head class="w-[80px]">Screenshot</Table.Head>
					<Table.Head class="w-[80px]">Data JSON</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each data.posts as post}
					<Table.Row>
						<Table.Cell class="font-mono text-xs">
							<a href="https://geo-astro-site.foodstarmelbourne.workers.dev/blog/{post.uuid}/{post.slug}" class="text-blue-500 hover:underline" target="_blank" rel="noopener">
								{post.slug}
							</a>
						</Table.Cell>
						<Table.Cell class="font-medium">{post.title || post.slug}</Table.Cell>
						<Table.Cell class="font-mono text-xs">{post.uuid || '—'}</Table.Cell>
						<Table.Cell>
							{#if post.hasScreenshot}
								<Badge variant="default" class="text-xs">Yes</Badge>
							{:else}
								<span class="text-xs text-muted-foreground">No</span>
							{/if}
						</Table.Cell>
						<Table.Cell>
							{#if post.hasDataJson}
								<Badge variant="default" class="text-xs">Yes</Badge>
							{:else}
								<span class="text-xs text-muted-foreground">No</span>
							{/if}
						</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</div>
</div>
