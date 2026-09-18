<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Globe, Map, FileText, Compass, BookOpen, PenTool, Edit, Search, User, Clock, CheckCircle2 } from 'lucide-svelte';

	let { data } = $props();

	let searchQuery = $state('');
	let selectedType = $state<'ALL' | 'MAP' | 'ATLAS' | 'ARTICLE' | 'GUIDE' | 'PORTAL' | 'BLOG' | 'WRITE'>('ALL');
	let viewMode = $state<'users' | 'stream'>('users');

	const typeColors: Record<string, { bg: string; text: string; border: string }> = {
		MAP: { bg: 'bg-blue-500/10 dark:bg-blue-500/20', text: 'text-blue-500', border: 'border-blue-500/30' },
		ATLAS: { bg: 'bg-emerald-500/10 dark:bg-emerald-500/20', text: 'text-emerald-500', border: 'border-emerald-500/30' },
		ARTICLE: { bg: 'bg-purple-500/10 dark:bg-purple-500/20', text: 'text-purple-500', border: 'border-purple-500/30' },
		GUIDE: { bg: 'bg-amber-500/10 dark:bg-amber-500/20', text: 'text-amber-500', border: 'border-amber-500/30' },
		PORTAL: { bg: 'bg-cyan-500/10 dark:bg-cyan-500/20', text: 'text-cyan-500', border: 'border-cyan-500/30' },
		BLOG: { bg: 'bg-rose-500/10 dark:bg-rose-500/20', text: 'text-rose-500', border: 'border-rose-500/30' },
		WRITE: { bg: 'bg-indigo-500/10 dark:bg-indigo-500/20', text: 'text-indigo-500', border: 'border-indigo-500/30' },
		PAGE: { bg: 'bg-gray-500/10 dark:bg-gray-500/20', text: 'text-gray-400', border: 'border-gray-500/30' }
	};

	function formatTime(ts: number): string {
		if (!ts) return 'Just now';
		const diff = Date.now() - ts;
		const mins = Math.floor(diff / 60000);
		if (mins < 1) return 'Just now';
		if (mins < 60) return `${mins}m ago`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `${hours}h ago`;
		return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	}

	// Filtered users
	const filteredUsers = $derived.by(() => {
		const q = searchQuery.toLowerCase().trim();
		return (data.users || []).filter((u: any) => {
			const matchesSearch = !q ||
				u.userName.toLowerCase().includes(q) ||
				u.userEmail.toLowerCase().includes(q) ||
				u.userId.toLowerCase().includes(q) ||
				u.recentPages.some((p: any) => p.title.toLowerCase().includes(q) || p.url.toLowerCase().includes(q));

			const matchesType = selectedType === 'ALL' || (u.breakdown && (u.breakdown[selectedType] || 0) > 0);
			return matchesSearch && matchesType;
		});
	});

	// Filtered stream
	const filteredVisits = $derived.by(() => {
		const q = searchQuery.toLowerCase().trim();
		return (data.recentVisits || []).filter((v: any) => {
			const matchesSearch = !q ||
				v.userName.toLowerCase().includes(q) ||
				v.userEmail.toLowerCase().includes(q) ||
				v.title.toLowerCase().includes(q) ||
				v.url.toLowerCase().includes(q);

			const matchesType = selectedType === 'ALL' || v.type === selectedType;
			return matchesSearch && matchesType;
		});
	});

	// Aggregated total breakdown
	const totalsByType = $derived.by(() => {
		const map: Record<string, number> = { MAP: 0, ATLAS: 0, ARTICLE: 0, GUIDE: 0, PORTAL: 0, BLOG: 0, WRITE: 0 };
		for (const v of data.recentVisits || []) {
			if (map[v.type] !== undefined) map[v.type] += 1;
		}
		return map;
	});
</script>

<div class="space-y-6 p-6">
	<!-- Page Header -->
	<div class="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
		<div>
			<h1 class="text-2xl font-bold tracking-tight">User Content Activity & Visits</h1>
			<p class="text-sm text-muted-foreground mt-1">
				Real-time monitoring of all users and which MAP, ATLAS, ARTICLE, GUIDE, PORTAL, BLOG, and WRITE pages they visit.
			</p>
		</div>
		<div class="flex items-center gap-2">
			<Button variant={viewMode === 'users' ? 'default' : 'outline'} size="sm" onclick={() => viewMode = 'users'}>
				<User class="mr-1.5 h-3.5 w-3.5" />
				By User ({data.usersCount})
			</Button>
			<Button variant={viewMode === 'stream' ? 'default' : 'outline'} size="sm" onclick={() => viewMode = 'stream'}>
				<Clock class="mr-1.5 h-3.5 w-3.5" />
				Live Stream ({data.totalVisits})
			</Button>
		</div>
	</div>

	<!-- Metric Cards Grid -->
	<div class="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
		<button
			type="button"
			class={['p-3 rounded-lg border text-left transition-all', selectedType === 'ALL' ? 'border-primary bg-primary/5 shadow-sm' : 'border-border bg-card hover:border-border/80']}
			onclick={() => selectedType = 'ALL'}
		>
			<div class="text-xs text-muted-foreground">Total Views</div>
			<div class="text-xl font-bold mt-0.5">{data.totalVisits}</div>
			<div class="text-[10px] text-muted-foreground mt-0.5">All types</div>
		</button>

		<button
			type="button"
			class={['p-3 rounded-lg border text-left transition-all', selectedType === 'MAP' ? 'border-blue-500 bg-blue-500/10' : 'border-border bg-card hover:border-border/80']}
			onclick={() => selectedType = 'MAP'}
		>
			<div class="text-xs text-blue-500 flex items-center gap-1"><Map class="h-3 w-3" /> Maps</div>
			<div class="text-xl font-bold mt-0.5">{totalsByType.MAP}</div>
			<div class="text-[10px] text-muted-foreground mt-0.5">3D & 2D views</div>
		</button>

		<button
			type="button"
			class={['p-3 rounded-lg border text-left transition-all', selectedType === 'ATLAS' ? 'border-emerald-500 bg-emerald-500/10' : 'border-border bg-card hover:border-border/80']}
			onclick={() => selectedType = 'ATLAS'}
		>
			<div class="text-xs text-emerald-500 flex items-center gap-1"><Globe class="h-3 w-3" /> Atlas</div>
			<div class="text-xl font-bold mt-0.5">{totalsByType.ATLAS}</div>
			<div class="text-[10px] text-muted-foreground mt-0.5">City explorations</div>
		</button>

		<button
			type="button"
			class={['p-3 rounded-lg border text-left transition-all', selectedType === 'ARTICLE' ? 'border-purple-500 bg-purple-500/10' : 'border-border bg-card hover:border-border/80']}
			onclick={() => selectedType = 'ARTICLE'}
		>
			<div class="text-xs text-purple-500 flex items-center gap-1"><FileText class="h-3 w-3" /> Articles</div>
			<div class="text-xl font-bold mt-0.5">{totalsByType.ARTICLE}</div>
			<div class="text-[10px] text-muted-foreground mt-0.5">Research reads</div>
		</button>

		<button
			type="button"
			class={['p-3 rounded-lg border text-left transition-all', selectedType === 'GUIDE' ? 'border-amber-500 bg-amber-500/10' : 'border-border bg-card hover:border-border/80']}
			onclick={() => selectedType = 'GUIDE'}
		>
			<div class="text-xs text-amber-500 flex items-center gap-1"><Compass class="h-3 w-3" /> Guides</div>
			<div class="text-xl font-bold mt-0.5">{totalsByType.GUIDE}</div>
			<div class="text-[10px] text-muted-foreground mt-0.5">POI field guides</div>
		</button>

		<button
			type="button"
			class={['p-3 rounded-lg border text-left transition-all', selectedType === 'PORTAL' ? 'border-cyan-500 bg-cyan-500/10' : 'border-border bg-card hover:border-border/80']}
			onclick={() => selectedType = 'PORTAL'}
		>
			<div class="text-xs text-cyan-500 flex items-center gap-1"><BookOpen class="h-3 w-3" /> Portals</div>
			<div class="text-xl font-bold mt-0.5">{totalsByType.PORTAL}</div>
			<div class="text-[10px] text-muted-foreground mt-0.5">Topic gateways</div>
		</button>

		<button
			type="button"
			class={['p-3 rounded-lg border text-left transition-all', (selectedType === 'BLOG' || selectedType === 'WRITE') ? 'border-rose-500 bg-rose-500/10' : 'border-border bg-card hover:border-border/80']}
			onclick={() => selectedType = selectedType === 'BLOG' ? 'WRITE' : 'BLOG'}
		>
			<div class="text-xs text-rose-500 flex items-center gap-1"><PenTool class="h-3 w-3" /> Blog / Write</div>
			<div class="text-xl font-bold mt-0.5">{totalsByType.BLOG + totalsByType.WRITE}</div>
			<div class="text-[10px] text-muted-foreground mt-0.5">Essays & posts</div>
		</button>
	</div>

	<!-- Search & Filters -->
	<div class="flex flex-col sm:flex-row items-center gap-3">
		<div class="relative flex-1 w-full">
			<Search class="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
			<Input
				placeholder="Filter by user (name/email/id) or visited title/URL..."
				class="pl-9 h-9 text-xs"
				bind:value={searchQuery}
			/>
		</div>
		{#if selectedType !== 'ALL'}
			<Button variant="ghost" size="sm" class="text-xs" onclick={() => selectedType = 'ALL'}>
				Clear filter ({selectedType}) ✕
			</Button>
		{/if}
	</div>

	<!-- VIEW MODE 1: BY USER -->
	{#if viewMode === 'users'}
		<div class="space-y-4">
			{#if filteredUsers.length === 0}
				<Card.Root>
					<Card.Content class="p-12 text-center text-sm text-muted-foreground">
						No user visits recorded matching your criteria yet.
					</Card.Content>
				</Card.Root>
			{:else}
				<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
					{#each filteredUsers as u}
						<Card.Root class="overflow-hidden border-border/80 shadow-sm flex flex-col justify-between">
							<Card.Header class="pb-3 border-b border-border/50 bg-muted/20">
								<div class="flex items-start justify-between gap-3">
									<div class="flex items-center gap-2.5 min-w-0">
										<div class="w-9 h-9 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-xs flex-shrink-0">
											{u.userName.slice(0, 2).toUpperCase()}
										</div>
										<div class="min-w-0">
											<div class="font-semibold text-sm truncate flex items-center gap-1.5">
												<span>{u.userName}</span>
												{#if u.userId !== 'anonymous'}
													<Badge variant="outline" class="text-[9px] px-1.5 py-0 h-4 border-emerald-500/40 text-emerald-500">
														Registered
													</Badge>
												{:else}
													<Badge variant="secondary" class="text-[9px] px-1.5 py-0 h-4">
														Guest
													</Badge>
												{/if}
											</div>
											<div class="text-xs text-muted-foreground font-mono truncate">{u.userEmail}</div>
										</div>
									</div>
									<div class="text-right flex-shrink-0">
										<Badge variant="outline" class="text-xs font-semibold">
											{u.totalVisits} views
										</Badge>
										<div class="text-[10px] text-muted-foreground mt-0.5">{formatTime(u.lastActive)}</div>
									</div>
								</div>

								<!-- Category breakdown pills -->
								<div class="flex flex-wrap gap-1.5 mt-3 pt-2 border-t border-border/40">
									{#each Object.entries(u.breakdown || {}) as [k, v]}
										{#if Number(v) > 0 && k !== 'PAGE'}
											<span class={['text-[10px] font-semibold px-2 py-0.5 rounded border', typeColors[k]?.bg ?? '', typeColors[k]?.text ?? '', typeColors[k]?.border ?? '']}>
												{k}: {v}
											</span>
										{/if}
									{/each}
								</div>
							</Card.Header>

							<Card.Content class="pt-3 pb-3">
								<div class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
									Visited Content ({u.recentPages.length})
								</div>
								<div class="space-y-1.5 max-h-56 overflow-y-auto pr-1">
									{#each u.recentPages as p}
										<a
											href={`https://geo-astro-site.foodstarmelbourne.workers.dev${p.url}`}
											target="_blank"
											rel="noopener noreferrer"
											class="flex items-center justify-between p-2 rounded-md bg-muted/30 hover:bg-muted/60 transition-colors group text-xs"
										>
											<div class="flex items-center gap-2 min-w-0 flex-1">
												<span class={['text-[9px] font-bold px-1.5 py-0.2 rounded uppercase border flex-shrink-0', typeColors[p.type]?.bg ?? '', typeColors[p.type]?.text ?? '', typeColors[p.type]?.border ?? '']}>
													{p.type}
												</span>
												<span class="font-medium truncate group-hover:text-primary transition-colors">
													{p.title || p.url}
												</span>
											</div>
											<span class="text-[10px] text-muted-foreground ml-2 flex-shrink-0 font-mono">
												{formatTime(p.timestamp)}
											</span>
										</a>
									{/each}
								</div>
							</Card.Content>
						</Card.Root>
					{/each}
				</div>
			{/if}
		</div>
	<!-- VIEW MODE 2: LIVE STREAM -->
	{:else}
		<Card.Root>
			<Card.Content class="p-0">
				{#if filteredVisits.length === 0}
					<div class="p-12 text-center text-sm text-muted-foreground">
						No visit records found.
					</div>
				{:else}
					<div class="divide-y divide-border">
						{#each filteredVisits as v}
							<div class="flex items-center justify-between p-4 hover:bg-muted/30 transition-colors">
								<div class="flex items-center gap-3 min-w-0 flex-1">
									<div class={['w-8 h-8 rounded-lg flex items-center justify-center font-bold text-xs border flex-shrink-0', typeColors[v.type]?.bg ?? '', typeColors[v.type]?.text ?? '', typeColors[v.type]?.border ?? '']}>
										{v.type.slice(0, 3)}
									</div>
									<div class="min-w-0 flex-1">
										<div class="flex items-center gap-2 flex-wrap">
											<span class="font-semibold text-sm">{v.userName}</span>
											<span class="text-xs text-muted-foreground font-mono">({v.userEmail})</span>
											<span class="text-muted-foreground">•</span>
											<span class="text-xs text-muted-foreground">visited</span>
											<span class={['text-[10px] font-bold uppercase px-1.5 py-0.2 rounded border', typeColors[v.type]?.bg ?? '', typeColors[v.type]?.text ?? '', typeColors[v.type]?.border ?? '']}>
												{v.type}
											</span>
										</div>
										<a
											href={`https://geo-astro-site.foodstarmelbourne.workers.dev${v.url}`}
											target="_blank"
											rel="noopener noreferrer"
											class="text-xs font-medium text-primary hover:underline truncate block mt-0.5"
										>
											{v.title || v.url}
										</a>
									</div>
								</div>
								<div class="text-right ml-4 flex-shrink-0">
									<div class="text-xs text-muted-foreground">{formatTime(v.timestamp)}</div>
									{#if v.country}
										<div class="text-[10px] text-muted-foreground font-mono">{v.country}</div>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</Card.Content>
		</Card.Root>
	{/if}
</div>
