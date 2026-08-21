<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { Folder, Map, FileText, LayoutTemplate, Shield } from '@lucide/svelte';

	let { data, children } = $props();

	const navItems = [
		{ href: '/admin', label: 'Fleet', icon: Shield },
		{ href: '/admin/categories', label: 'Categories', icon: Folder },
		{ href: '/admin/maps', label: 'Maps', icon: Map },
		{ href: '/admin/blog', label: 'Blog Posts', icon: FileText },
		{ href: '/admin/templates', label: 'Templates', icon: LayoutTemplate },
	];

	const isActive = (href: string) =>
		href === '/admin' ? page.url.pathname === '/admin' : page.url.pathname.startsWith(href);
</script>

<div class="flex min-h-screen flex-col sm:flex-row">
	<!-- Sidebar -->
	<aside class="flex shrink-0 flex-col border-b border-border/40 bg-muted/30 sm:w-56 sm:border-b-0 sm:border-r">
		<div class="flex items-center gap-2 px-4 py-4">
			<Shield class="size-4 text-muted-foreground" />
			<span class="text-sm font-semibold">Geo Admin</span>
		</div>
		<nav class="flex flex-row gap-1 px-2 pb-2 sm:flex-col">
			{#each navItems as item}
				<a
					href={item.href}
					class="flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted
					{isActive(item.href) ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground'}"
				>
					<item.icon class="size-4" />
					<span>{item.label}</span>
				</a>
			{/each}
		</nav>
	</aside>

	<!-- Content -->
	<main class="flex-1 overflow-auto">
		{@render children()}
	</main>
</div>
