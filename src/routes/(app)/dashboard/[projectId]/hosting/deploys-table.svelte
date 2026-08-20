<script lang="ts">
	import type { HostingDeploy } from '$lib/agents';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';

	/**
	 * The deploy history list: keyset paging, range-of-total + Prev/Next, never
	 * truncation. Prev walks a client-side stack of the cursors that STARTED
	 * each page, so a poll-refreshed current page never yanks the operator back
	 * to the top. Shared by the hosting hub (project-wide) and the per-app
	 * Deployments tab (`app` filter).
	 */
	let {
		projectId,
		app = null,
		pageSize = 10,
		showApp = false
	}: {
		projectId: string;
		/** Filter to one app; null = the whole project. */
		app?: string | null;
		pageSize?: number;
		/** Show the app name per row (useful on the project-wide list). */
		showApp?: boolean;
	} = $props();

	let deploys = $state<HostingDeploy[]>([]);
	let total = $state(0);
	let nextCursor = $state<string | null>(null);
	let cursorStack = $state<string[]>([]);
	let pageStart = $state(0);

	async function load(cursor: string | null) {
		const query = [
			`limit=${pageSize}`,
			...(app ? [`app=${encodeURIComponent(app)}`] : []),
			...(cursor ? [`cursor=${encodeURIComponent(cursor)}`] : [])
		].join('&');
		const response = await fetch(`/api/projects/${projectId}/hosting/deploys?${query}`).catch(
			() => null
		);
		if (!response?.ok) return;
		const body = (await response.json().catch(() => null)) as {
			deploys: HostingDeploy[];
			total: number;
			cursor: string | null;
		} | null;
		if (!body) return;
		deploys = body.deploys;
		total = body.total;
		nextCursor = body.cursor;
	}

	$effect(() => {
		// Re-runs when the filter changes; resets to the first page.
		void app;
		cursorStack = [];
		pageStart = 0;
		void load(null);
	});

	async function nextPage() {
		if (!nextCursor) return;
		cursorStack = [...cursorStack, nextCursor];
		pageStart += deploys.length;
		await load(nextCursor);
	}
	async function prevPage() {
		if (!cursorStack.length) return;
		const stack = cursorStack.slice(0, -1);
		cursorStack = stack;
		pageStart = Math.max(0, pageStart - pageSize);
		await load(stack[stack.length - 1] ?? null);
	}

	const timeAgo = (iso: string) => {
		const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
		if (seconds < 60) return 'just now';
		if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
		if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
		return `${Math.floor(seconds / 86400)}d ago`;
	};
	const kb = (bytes: number) =>
		bytes < 1024
			? `${bytes} B`
			: bytes < 1024 * 1024
				? `${Math.round(bytes / 1024)} KB`
				: `${(bytes / 1024 / 1024).toFixed(1)} MB`;
</script>

{#if deploys.length === 0}
	<p class="text-sm text-muted-foreground">No deploys yet.</p>
{:else}
	<div class="grid gap-2">
		{#each deploys as deploy (deploy.id)}
			<div class="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3">
				<Badge variant={deploy.status === 'live' ? 'default' : 'outline'} class="shrink-0 text-xs">
					{deploy.status}
				</Badge>
				<div class="min-w-0 flex-1">
					<p class="truncate font-mono text-xs">
						{showApp ? `${deploy.appName} · ` : ''}{deploy.subdomain}
					</p>
					<p class="text-xs text-muted-foreground">
						{deploy.hasWorker ? 'worker + ' : ''}{deploy.assetCount} asset{deploy.assetCount === 1
							? ''
							: 's'} · {kb(deploy.assetBytes + deploy.moduleBytes)}
					</p>
				</div>
				<p class="shrink-0 text-xs text-muted-foreground">{timeAgo(deploy.createdAt)}</p>
			</div>
		{/each}
	</div>
	<div class="flex items-center justify-between text-xs text-muted-foreground">
		<span data-testid="hosting-deploys-range">
			{pageStart + 1}–{pageStart + deploys.length} of {total}
		</span>
		<div class="flex gap-2">
			<Button size="sm" variant="outline" disabled={cursorStack.length === 0} onclick={prevPage}>
				Prev
			</Button>
			<Button size="sm" variant="outline" disabled={!nextCursor} onclick={nextPage}>Next</Button>
		</div>
	</div>
{/if}
