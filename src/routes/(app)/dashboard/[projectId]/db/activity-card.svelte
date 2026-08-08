<script lang="ts">
	// The agent's activity feed, filtered by the page that renders it: the
	// collections page shows collection/document events, the tables page shows
	// table/row events. Deliberately NOT one tabbed card - browsing collections
	// should never surface table traffic, and each tool page owns its own story.
	import type { DbActivityEvent } from '$lib/agents';
	import * as Card from '$lib/components/ui/card';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import {
		Activity,
		FileText,
		FolderPlus,
		History,
		Radio,
		Rocket,
		ShieldCheck,
		Trash2,
		Upload
	} from '@lucide/svelte';

	let { events, empty = 'Nothing yet.' }: { events: DbActivityEvent[]; empty?: string } = $props();

	const eventIcons = {
		'project.provisioned': Rocket,
		'collection.created': FolderPlus,
		'collection.deleted': Trash2,
		'collection.configured': ShieldCheck,
		'collection.restored': History,
		'documents.changed': FileText,
		'documents.imported': Upload,
		'table.created': FolderPlus,
		'table.configured': ShieldCheck,
		'table.deleted': Trash2,
		'table.restored': History,
		'rows.changed': FileText,
		'rows.imported': Upload
	} as const;

	function timeAgo(iso: string): string {
		const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
		if (seconds < 60) return `${seconds}s ago`;
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h ago`;
		return `${Math.floor(hours / 24)}d ago`;
	}
</script>

<Card.Root data-testid="db-activity">
	<Card.Header>
		<Card.Title class="flex items-center gap-2">
			<Radio class="h-4 w-4 text-primary" /> Live activity
		</Card.Title>
		<Card.Description>Streamed from the agent via WebSocket state sync.</Card.Description>
	</Card.Header>
	<Card.Content>
		{#if events.length === 0}
			<p class="py-6 text-center text-sm text-muted-foreground">{empty}</p>
		{:else}
			<ScrollArea class="h-72 pr-3" type="always">
				<ol class="space-y-4">
					{#each events as event (event.id)}
						{@const Icon = eventIcons[event.type] ?? Activity}
						<li class="flex gap-3">
							<div
								class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
							>
								<Icon class="h-3.5 w-3.5" />
							</div>
							<div class="min-w-0">
								<p class="text-sm leading-snug">{event.message}</p>
								<p class="mt-0.5 font-mono text-[11px] text-muted-foreground">
									{event.type} · {timeAgo(event.at)}
								</p>
							</div>
						</li>
					{/each}
				</ol>
			</ScrollArea>
		{/if}
	</Card.Content>
</Card.Root>
