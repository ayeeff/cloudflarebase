<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as Tabs from '$lib/components/ui/tabs';
	import type { ConsoleNavItem } from '$lib/agent-registry';

	/**
	 * Quick-switcher between an agent's tool PAGES: the shadcn Tabs component
	 * with the current route as its value, navigating on change - the routes
	 * are the state. Supplements the sidebar (which stays the canonical
	 * navigation); on narrow screens the list scrolls horizontally.
	 */
	let { items }: { items: ConsoleNavItem[] } = $props();

	const active = $derived(items.find((item) => item.href === page.url.pathname)?.href ?? '');
</script>

<Tabs.Root
	value={active}
	onValueChange={(value) => {
		if (value && value !== page.url.pathname) {
			void goto(value);
		}
	}}
	class="w-fit max-w-full"
>
	<Tabs.List
		class="max-w-full justify-start overflow-x-auto overflow-y-hidden"
		data-testid="tool-tabs"
	>
		{#each items as item (item.testId)}
			<Tabs.Trigger value={item.href} data-testid={`tab-${item.testId}`}>
				{item.title}
			</Tabs.Trigger>
		{/each}
	</Tabs.List>
</Tabs.Root>
