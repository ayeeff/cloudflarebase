<script lang="ts">
	import { browser } from '$app/environment';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { buildConsoleNav } from '$lib/agent-registry';
	import type { AgentChatMessage, AgentChatReply } from '$lib/agents';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Collapsible from '$lib/components/ui/collapsible';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Resizable from '$lib/components/ui/resizable';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import { IsMobile } from '$lib/hooks/is-mobile.svelte';
	import { createBranchSchema, projectIdSchema } from '$lib/schemas/auth';
	import ModeToggle from '$lib/components/mode-toggle.svelte';
	import { onMount, tick } from 'svelte';
	import { cubicOut } from 'svelte/easing';
	import { fly } from 'svelte/transition';
	import {
		BookOpen,
		Bot,
		Check,
		ChevronDown,
		ChevronsUpDown,
		Clock,
		Database,
		FlaskConical,
		FolderTree,
		GitBranch,
		Globe,
		HardDrive,
		History,
		House,
		KeyRound,
		LayoutGrid,
		Menu,
		Plug,
		Plus,
		Radio,
		SendHorizontal,
		Settings,
		ShieldCheck,
		Sparkles,
		Table2,
		TerminalSquare,
		UsersRound,
		X,
		Zap
	} from '@lucide/svelte';

	let { children, data } = $props();

	const projectId = $derived(page.params.projectId ?? 'demo');
	const isMobile = new IsMobile();
	// Open state and pane sizes come from the cfbase-copilot cookie via the
	// layout server load, so SSR already renders the saved layout - reopening
	// the dashboard never flashes the default widths. Mobile uses the tab bar.
	// Initial-value captures are deliberate: this component is the only writer.
	// svelte-ignore state_referenced_locally
	let copilotOpen = $state(data.copilot.open);
	let mobileAgentOpen = $state(false);
	// svelte-ignore state_referenced_locally
	const initialPaneLayout = data.copilot.layout ?? [70, 30];
	let paneSizes = initialPaneLayout;
	let copilotInput = $state('');
	let copilotBusy = $state(false);
	type CopilotMessage = AgentChatMessage & { mode?: string };
	let copilotMessages = $state<CopilotMessage[]>([]);
	let copilotMessagesEl = $state<HTMLElement | null>(null);
	let pendingHistoryScroll = $state(false);
	// Starts true so the first paint shows the skeleton, not a flash of the
	// empty state, while the initial history request is in flight.
	let copilotHistoryLoading = $state(true);

	// --- Demo claim: "Keep this project" (docs/managed-service-design.md).
	// A SYNTHESIZED branch context (branchCtx?.demo) is the unclaimed signal -
	// the moment the claim registers the row, the layout load serves the
	// registry-backed context instead and the affordance disappears. Anonymous
	// visitors route through /login and land back here with ?claim=1, which
	// auto-claims on mount.
	let claimBusy = $state(false);
	let claimError = $state(false);

	async function claimDemo(targetId: string): Promise<void> {
		if (claimBusy) return;
		claimBusy = true;
		claimError = false;
		try {
			const response = await fetch(`/api/registry/projects/${targetId}/claim`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({})
			});
			// 207: claimed, but an agent kept its demo limits - ownership holds,
			// so the console proceeds like a success.
			if (!response.ok && response.status !== 207) {
				claimError = true;
				return;
			}
			await goto(resolve('/(app)/dashboard/[projectId]', { projectId: targetId }), {
				invalidateAll: true
			});
		} catch {
			claimError = true;
		} finally {
			claimBusy = false;
		}
	}

	const overviewHref = $derived(resolve('/(app)/dashboard/[projectId]', { projectId }));
	const apiHref = $derived(resolve('/(app)/dashboard/[projectId]/api', { projectId }));
	const isApi = $derived(page.url.pathname.startsWith(apiHref));

	const isOverview = $derived(page.url.pathname === overviewHref);

	// Agent-contributed navigation, built from the manifest registry: each
	// agent's console.pages become sidebar and mobile links. Icon names are
	// manifest strings mapped to lucide components here.
	const agentNav = $derived(buildConsoleNav(projectId));
	const navIcons: Record<string, typeof KeyRound> = {
		'key-round': KeyRound,
		database: Database,
		'flask-conical': FlaskConical,
		'folder-tree': FolderTree,
		globe: Globe,
		history: History,
		plug: Plug,
		settings: Settings,
		'shield-check': ShieldCheck,
		table: Table2,
		'terminal-square': TerminalSquare,
		users: UsersRound
	};
	// Exact match: tool pages are siblings now (/db must not light on
	// /db/tables); the API reference keeps its own prefix check via isApi.
	const navActive = (href: string) => page.url.pathname === href;

	const comingSoon = [
		{ label: 'Storage', icon: HardDrive },
		{ label: 'Functions', icon: Zap },
		{ label: 'Realtime', icon: Radio },
		{ label: 'Cron & Queues', icon: Clock }
	];

	// Grounded in what the copilot's tools can actually read: auth overview and
	// analytics, database collections, and real documents.
	const copilotSuggestionPool = [
		'Summarize this project',
		'What should I investigate?',
		'How is user activity?',
		"What's our DAU/MAU ratio?",
		"What's our churn rate?",
		'How many anonymous users do we have?',
		'Which sign-in providers are most used?',
		'What countries are users from?',
		'How many sessions are active right now?',
		'Are sign-ups trending up this week?',
		'Compare guest and registered sign-ups',
		'Which auth events fired in the last day?',
		'Is anything unusual in the auth activity?',
		'What collections do we have?',
		'How many documents are in each collection?',
		'Show me the latest documents',
		'Which collections are public?'
	];

	function pickSuggestions(): string[] {
		const pool = [...copilotSuggestionPool];
		for (let i = pool.length - 1; i > 0; i -= 1) {
			const j = Math.floor(Math.random() * (i + 1));
			[pool[i], pool[j]] = [pool[j], pool[i]];
		}
		return pool.slice(0, 3);
	}

	let copilotSuggestions = $state(pickSuggestions());

	$effect(() => {
		const currentProject = projectId;
		copilotMessages = [];
		pendingHistoryScroll = false;
		copilotHistoryLoading = true;
		void loadCopilotHistory(currentProject);
	});

	const copilotVisible = $derived(isMobile.current ? mobileAgentOpen : copilotOpen);

	$effect(() => {
		if (copilotVisible && pendingHistoryScroll && copilotMessagesEl) {
			const el = copilotMessagesEl;
			pendingHistoryScroll = false;
			tick().then(() => el.scrollTo({ top: el.scrollHeight }));
		}
	});

	async function loadCopilotHistory(currentProject: string) {
		copilotHistoryLoading = true;
		try {
			const response = await fetch(`/api/projects/${currentProject}/chat`);
			if (currentProject !== projectId) return;
			if (!response.ok) {
				copilotMessages = [];
				return;
			}
			const history = (await response.json()) as { messages: AgentChatMessage[] };
			copilotMessages = history.messages;
			pendingHistoryScroll = copilotMessages.length > 0;
		} catch {
			// Keep chat usable when history cannot be loaded.
		} finally {
			if (currentProject === projectId) copilotHistoryLoading = false;
		}
	}

	// --- Breadcrumb switchers (Neon-style shell). data.branches is null on
	// demo/unregistered projects, which hides the branch controls entirely;
	// data.projects is null for anonymous demo visitors, so the registry list
	// never reaches their page data and the project crumb stays static. ---
	const branchCtx = $derived(data.branches);
	/** What the project crumb names: the ROOT id - the branch is its own crumb. */
	const rootId = $derived(branchCtx?.rootId ?? projectId);
	/** Roots only: branches are reached through the branch crumb, not this list. */
	const rootProjects = $derived((data.projects ?? []).filter((entry) => !entry.parentId));
	// data-hydrated on the trigger, the suite's convention: the dropdown only
	// answers clicks after hydration, so tests wait for this before clicking.
	let hydrated = $state(false);
	/** Unclaimed demo family = synthesized branch context (only ever built in
	 * demo mode); demoClaimable = the flow can actually complete (signed-in,
	 * or the console reports open sign-ups - a claimed console's /login is a
	 * dead end for an anonymous visitor, so no button). */
	const claimableDemo = $derived(!!branchCtx?.demo && data.demoClaimable);
	const signedIn = $derived(data.projects !== null);
	const loginClaimHref = $derived(
		`${resolve('/(app)/login')}?next=${encodeURIComponent(
			`${resolve('/(app)/dashboard/[projectId]', { projectId: rootId })}?claim=1`
		)}`
	);
	onMount(() => {
		hydrated = true;
		// The post-login landing: /login bounced the visitor back with ?claim=1.
		if (page.url.searchParams.has('claim') && signedIn && claimableDemo) {
			void claimDemo(rootId);
		}
	});

	// Below lg the sidebar becomes a hamburger drawer: the SAME aside slides
	// in as a fixed overlay, so mobile and desktop can never drift. Closes on
	// any navigation (the pathname effect) or the backdrop.
	let mobileNavOpen = $state(false);
	$effect(() => {
		void page.url.pathname;
		mobileNavOpen = false;
	});
	let newBranchOpen = $state(false);
	let newBranchName = $state('');
	let newBranchError = $state('');
	let newBranchBusy = $state(false);
	/** Branch-name budget: its own 16-char grammar, shrunk when the root id
	 * leaves less room under the combined 48-char project-id ceiling. */
	const maxBranchChars = $derived(
		branchCtx ? Math.max(1, Math.min(16, 48 - branchCtx.rootId.length - 2)) : 16
	);

	/** Same tool page, other branch: swap only the project segment. */
	function branchHref(targetId: string): string {
		const base = resolve('/(app)/dashboard/[projectId]', { projectId });
		const target = resolve('/(app)/dashboard/[projectId]', { projectId: targetId });
		return target + page.url.pathname.slice(base.length);
	}

	async function createBranch(event: SubmitEvent) {
		event.preventDefault();
		if (!branchCtx) return;
		const parsed = createBranchSchema.safeParse({ branch: newBranchName.trim() });
		if (!parsed.success) {
			newBranchError = parsed.error.issues[0]?.message ?? 'Invalid branch name.';
			return;
		}
		// Demo branches are id-derived, never registry rows: creating one is
		// just navigating to it - the agents lazily materialize the instances,
		// and the demo pattern gives them the family's caps and TTL.
		if (branchCtx.demo) {
			const branchId = `${branchCtx.rootId}--${parsed.data.branch}`;
			if (!projectIdSchema.safeParse(branchId).success) {
				newBranchError = 'the combined id exceeds 48 characters - use a shorter branch name';
				return;
			}
			newBranchOpen = false;
			newBranchName = '';
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- branchHref builds on resolve() and swaps only the project segment
			await goto(branchHref(branchId));
			return;
		}
		newBranchBusy = true;
		try {
			const response = await fetch(`/api/projects/${branchCtx.rootId}/branches`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(parsed.data)
			});
			const body = (await response.json().catch(() => null)) as {
				error?: string;
				branch?: { id: string };
			} | null;
			if (!response.ok || !body?.branch) {
				newBranchError = body?.error ?? 'Could not create the branch.';
				return;
			}
			newBranchOpen = false;
			newBranchName = '';
			await invalidateAll();
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- branchHref builds on resolve() and swaps only the project segment
			await goto(branchHref(body.branch.id));
		} finally {
			newBranchBusy = false;
		}
	}

	function persistCopilotCookie() {
		if (!browser) return;
		const value = `${copilotOpen ? 'open' : 'closed'}:${paneSizes
			.map((size) => Math.round(size))
			.join(':')}`;
		document.cookie = `cfbase-copilot=${value}; path=/; max-age=31536000; samesite=lax`;
	}

	function setCopilotOpen(open: boolean) {
		copilotOpen = open;
		if (open) pendingHistoryScroll = copilotMessages.length > 0;
		persistCopilotCookie();
	}

	function onPaneLayoutChange(layout: number[]) {
		// Only record real two-pane layouts: a collapsed agent pane reports
		// [100, 0], and overwriting the saved sizes with it would lose the
		// width the user should get back on reopen.
		if (layout.length === 2 && layout[1] >= 15) {
			paneSizes = layout;
			persistCopilotCookie();
		}
	}

	let agentPane = $state<ReturnType<typeof Resizable.Pane>>();
	let agentPaneRef = $state<HTMLElement | null>(null);
	// Disable the flex-grow transition while dragging so resizing tracks the
	// cursor 1:1; the transition only plays for collapse/expand.
	let paneDragging = $state(false);
	// While collapsing/expanding, the panel content is pinned to its expanded
	// pixel width so the shrinking pane clips it (a clean slide, like VS Code)
	// instead of continuously reflowing the chat.
	let panelPinnedWidth = $state(0);
	let panelPinTimer: ReturnType<typeof setTimeout> | undefined;

	function closeCopilot() {
		clearTimeout(panelPinTimer);
		panelPinnedWidth = agentPaneRef?.getBoundingClientRect().width ?? 0;
		setCopilotOpen(false);
		agentPane?.collapse();
	}

	function openCopilot() {
		setCopilotOpen(true);
		agentPane?.resize(Math.min(55, Math.max(20, paneSizes[1] ?? 30)));
		panelPinTimer = setTimeout(() => (panelPinnedWidth = 0), 350);
	}

	function showMobileAgent(show: boolean) {
		mobileAgentOpen = show;
		if (show) pendingHistoryScroll = copilotMessages.length > 0;
	}

	function scrollCopilotToLatest() {
		const el = copilotMessagesEl;
		if (!el) return;
		void tick().then(() => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }));
	}

	async function askCopilot(question: string) {
		const trimmed = question.trim();
		if (!trimmed || copilotBusy) return;
		copilotBusy = true;
		copilotInput = '';
		const currentProject = projectId;
		const pendingId = crypto.randomUUID();
		copilotMessages = [
			...copilotMessages,
			{ id: pendingId, role: 'user', content: trimmed, createdAt: new Date().toISOString() }
		];
		scrollCopilotToLatest();
		try {
			const response = await fetch(`/api/projects/${currentProject}/chat`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ question: trimmed })
			});
			// The user may have switched projects while the request was in flight;
			// this reply belongs to the previous project's conversation.
			if (currentProject !== projectId) return;
			const reply = (await response.json()) as AgentChatReply & { error?: string };
			if (response.ok) {
				copilotMessages = [
					...copilotMessages.filter((message) => message.id !== pendingId),
					reply.userMessage,
					{ ...reply.agentMessage, mode: reply.mode }
				];
			} else {
				copilotMessages = [
					...copilotMessages,
					{
						id: crypto.randomUUID(),
						role: 'agent',
						content: reply.error ?? 'I could not answer that.',
						createdAt: new Date().toISOString()
					}
				];
			}
		} catch {
			if (currentProject !== projectId) return;
			copilotMessages = [
				...copilotMessages,
				{
					id: crypto.randomUUID(),
					role: 'agent',
					content: 'The project agent is unavailable.',
					createdAt: new Date().toISOString()
				}
			];
		} finally {
			copilotBusy = false;
			copilotSuggestions = pickSuggestions();
			scrollCopilotToLatest();
		}
	}
</script>

<svelte:head>
	<meta name="robots" content="noindex, nofollow, noarchive" />
</svelte:head>

{#snippet branchMenuItems(ctx: NonNullable<typeof data.branches>)}
	<!-- eslint-disable svelte/no-navigation-without-resolve -- branchHref builds on resolve() and swaps only the project segment -->
	<!-- Demo contexts have no `main`: the bare root is listed AS production. -->
	{#if !ctx.demo}
		<DropdownMenu.Item data-testid="branch-item-main">
			{#snippet child({ props })}
				<a {...props} href={branchHref(ctx.rootId)}>
					<GitBranch class="h-4 w-4" />
					<span class="truncate font-mono text-xs">main</span>
					{#if !ctx.current}<Check class="ml-auto h-4 w-4" />{/if}
				</a>
			{/snippet}
		</DropdownMenu.Item>
	{/if}
	{#each ctx.branches as branch (branch.id)}
		<DropdownMenu.Item data-testid={`branch-item-${branch.branchName}`}>
			{#snippet child({ props })}
				<a {...props} href={branchHref(branch.id)}>
					<GitBranch class="h-4 w-4" />
					<span class="truncate font-mono text-xs">{branch.branchName}</span>
					{#if ctx.current === branch.branchName}<Check class="ml-auto h-4 w-4" />{/if}
				</a>
			{/snippet}
		</DropdownMenu.Item>
	{/each}
	<!-- eslint-enable svelte/no-navigation-without-resolve -->
	<DropdownMenu.Separator />
	<DropdownMenu.Item
		data-testid="new-branch"
		onclick={() => {
			newBranchName = '';
			newBranchError = '';
			newBranchOpen = true;
		}}
	>
		<Plus class="h-4 w-4" /> New branch…
	</DropdownMenu.Item>
{/snippet}

{#snippet copilotPanel(desktop: boolean)}
	<section
		class="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
		style={desktop && panelPinnedWidth
			? `width: ${panelPinnedWidth}px; min-width: ${panelPinnedWidth}px;`
			: undefined}
		data-testid="project-copilot"
	>
		<header class="flex shrink-0 items-center gap-3 border-b px-4 py-3 md:h-14 md:py-0">
			<div
				class="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground"
			>
				<Sparkles class="h-4 w-4" />
			</div>
			<div class="min-w-0 flex-1">
				<div class="flex items-center gap-2">
					<h2 class="text-sm font-semibold">Project agent</h2>
					<Badge variant="secondary" class="text-[9px]">Workers AI</Badge>
				</div>
				<p class="truncate text-xs text-muted-foreground">Live context for {projectId}</p>
			</div>
			{#if desktop}
				<Button
					size="icon"
					variant="ghost"
					class="h-8 w-8"
					onclick={closeCopilot}
					aria-label="Close project agent"
				>
					<X class="h-4 w-4" />
				</Button>
			{/if}
		</header>

		<ScrollArea
			type="always"
			class="min-h-0 flex-1"
			scrollbarYClasses="data-vertical:w-1.5 data-vertical:border-l-0"
			bind:viewportRef={copilotMessagesEl}
		>
			<div class="space-y-3 p-4" data-testid="copilot-messages">
				{#if copilotHistoryLoading && copilotMessages.length === 0}
					<div class="space-y-3" data-testid="copilot-history-loading" aria-hidden="true">
						<div class="h-14 w-3/4 animate-pulse rounded-xl bg-muted/60"></div>
						<div class="ml-auto h-9 w-1/2 animate-pulse rounded-xl bg-muted/60"></div>
						<div class="h-14 w-2/3 animate-pulse rounded-xl bg-muted/60"></div>
					</div>
				{:else if copilotMessages.length === 0}
					<div class="rounded-xl border bg-muted/40 p-4">
						<div class="mb-2 flex items-center gap-2 text-sm font-medium">
							<Bot class="h-4 w-4 text-primary" /> What can I help with?
						</div>
						<p class="text-xs leading-relaxed text-muted-foreground">
							I can explain usage, compare activity, surface authentication issues, and look through
							this project's database collections and documents.
						</p>
					</div>
				{/if}
				{#each copilotMessages as message (message.id)}
					<div
						class={[
							'max-w-[88%] rounded-xl px-3 py-2.5 text-sm leading-relaxed',
							message.role === 'user' ? 'ml-auto bg-foreground text-background' : 'border bg-card'
						]}
					>
						{message.content}
						{#if message.role === 'agent' && message.mode}
							<p class="mt-2 text-[9px] tracking-wider uppercase opacity-60">
								Generated by Workers AI
							</p>
						{/if}
					</div>
				{/each}
				{#if copilotBusy}
					<p class="flex items-center gap-2 text-xs text-muted-foreground">
						<span class="h-2 w-2 animate-pulse rounded-full bg-primary"></span>Analyzing live data…
					</p>
				{/if}
				{#if !copilotHistoryLoading && !copilotBusy}
					<div class="grid gap-2" data-testid="copilot-suggestions">
						{#each copilotSuggestions as suggestion (suggestion)}
							<button
								class="rounded-lg border px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-foreground"
								onclick={() => askCopilot(suggestion)}
							>
								{suggestion}
							</button>
						{/each}
					</div>
				{/if}
			</div>
		</ScrollArea>

		<form
			class="border-t p-3"
			onsubmit={(event) => {
				event.preventDefault();
				void askCopilot(copilotInput);
			}}
		>
			<div class="flex items-center gap-2 rounded-xl border bg-muted/30 p-2">
				<Input
					bind:value={copilotInput}
					class="border-0 bg-transparent shadow-none focus-visible:ring-0"
					placeholder="Ask about your project…"
					aria-label="Ask project agent"
				/>
				<Button
					type="submit"
					size="icon"
					class="h-8 w-8 shrink-0"
					disabled={copilotBusy || !copilotInput.trim()}
					aria-label="Send to project agent"><SendHorizontal class="h-3.5 w-3.5" /></Button
				>
			</div>
			<p class="mt-2 text-center text-[10px] text-muted-foreground">
				Answers from live project data. Verify important decisions.
			</p>
		</form>
	</section>
{/snippet}

<div class="flex h-dvh overflow-hidden bg-background text-foreground">
	<!-- Sidebar: two labeled groups, Neon-style. PROJECT holds the cross-project
	     links; BRANCH holds the branch select and every per-branch tool - the
	     agent nav, coming-soon primitives, and the API reference all operate on
	     the current branch's agent instances. The brand lives in the header
	     breadcrumb now. -->
	{#if mobileNavOpen}
		<button
			type="button"
			class="fixed inset-0 z-40 bg-black/40 lg:hidden"
			aria-label="Close menu"
			onclick={() => (mobileNavOpen = false)}
		></button>
	{/if}
	<aside
		class={[
			'w-60 shrink-0 flex-col border-r border-border bg-card',
			mobileNavOpen ? 'fixed inset-y-0 left-0 z-50 flex shadow-xl' : 'hidden',
			'lg:static lg:z-auto lg:flex lg:shadow-none'
		]}
	>
		<a
			href={resolve('/')}
			class="flex h-14 shrink-0 items-center gap-2 border-b border-border px-5 font-bold"
		>
			<img src="/brand/mark.svg" alt="" class="h-5 w-5" />
			Cloudflarebase
		</a>

		<nav class="flex-1 space-y-6 overflow-y-auto px-3 py-4">
			<div>
				<p
					class="px-3 pb-2 text-[11px] font-medium tracking-wider text-muted-foreground/70 uppercase"
				>
					Project
				</p>
				<a
					href={resolve('/(app)/dashboard')}
					data-testid="nav-all-projects"
					class="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
				>
					<LayoutGrid class="h-4 w-4" />
					All projects
				</a>
				<a
					href={overviewHref}
					data-testid="nav-overview"
					class={[
						'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
						isOverview
							? 'bg-primary/10 text-primary'
							: 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
					]}
				>
					<House class="h-4 w-4" />
					Overview
				</a>
			</div>

			<div>
				<p
					class="px-3 pb-2 text-[11px] font-medium tracking-wider text-muted-foreground/70 uppercase"
				>
					Branch
				</p>
				{#if branchCtx}
					{@const ctx = branchCtx}
					<div class="px-3 pb-3">
						<DropdownMenu.Root>
							<DropdownMenu.Trigger>
								{#snippet child({ props })}
									<button
										{...props}
										type="button"
										class="flex w-full items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-left text-xs font-medium transition-colors hover:bg-accent"
										aria-label="Switch branch"
										data-testid="sidebar-branch-select"
									>
										<GitBranch class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
										<span class="truncate font-mono">{ctx.current ?? 'main'}</span>
										<ChevronsUpDown class="ml-auto h-3 w-3 shrink-0 text-muted-foreground" />
									</button>
								{/snippet}
							</DropdownMenu.Trigger>
							<DropdownMenu.Content align="start" class="w-52">
								{@render branchMenuItems(ctx)}
							</DropdownMenu.Content>
						</DropdownMenu.Root>
					</div>
				{/if}
			</div>

			<!-- One FOLDABLE group per agent (Authentication ▾, Database ▾, ...),
			     each listing its tool pages as nested items - Neon/Supabase
			     style, driven entirely by the manifest registry's console.pages.
			     Open by default; folding is per pageview, deliberately unsaved. -->
			{#each agentNav as navSection (navSection.section)}
				<Collapsible.Root open>
					<Collapsible.Trigger
						class="group flex w-full items-center justify-between rounded-md px-3 pb-2 text-[11px] font-medium tracking-wider text-muted-foreground/70 uppercase transition-colors hover:text-foreground"
						data-testid={`nav-section-${navSection.section.toLowerCase()}`}
					>
						{navSection.section}
						<ChevronDown
							class="h-3.5 w-3.5 transition-transform group-data-[state=closed]:-rotate-90"
						/>
					</Collapsible.Trigger>
					<Collapsible.Content class="space-y-0.5 pl-2">
						<!-- eslint-disable svelte/no-navigation-without-resolve -- manifest-driven hrefs are prebuilt project-relative paths -->
						{#each navSection.items as item (item.testId)}
							{@const NavIcon = navIcons[item.icon] ?? KeyRound}
							<a
								href={item.href}
								data-testid={item.testId}
								class={[
									'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
									navActive(item.href)
										? 'bg-primary/10 text-primary'
										: 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
								]}
							>
								<NavIcon class="h-4 w-4" />
								{item.title}
							</a>
						{/each}
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
					</Collapsible.Content>
				</Collapsible.Root>
			{/each}

			<div>
				<p
					class="px-3 pb-2 text-[11px] font-medium tracking-wider text-muted-foreground/70 uppercase"
				>
					Coming soon
				</p>
				{#each comingSoon as item (item.label)}
					<span
						class="flex cursor-default items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground/50"
					>
						<item.icon class="h-4 w-4" />
						{item.label}
						<Badge variant="outline" class="ml-auto text-[10px] text-muted-foreground/60"
							>soon</Badge
						>
					</span>
				{/each}
			</div>

			<div>
				<p
					class="px-3 pb-2 text-[11px] font-medium tracking-wider text-muted-foreground/70 uppercase"
				>
					Reference
				</p>
				<a
					href={apiHref}
					data-testid="nav-api"
					class={[
						'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
						isApi
							? 'bg-primary/10 text-primary'
							: 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
					]}
				>
					<BookOpen class="h-4 w-4" />
					API Reference
				</a>
			</div>
		</nav>

		<div class="border-t border-border px-5 py-3 text-[11px] text-muted-foreground/60">
			Running on Cloudflare's network
		</div>
	</aside>

	<!-- Main content and agent pane, VS Code style: backend left, agent right -->
	<Resizable.PaneGroup
		direction="horizontal"
		onLayoutChange={onPaneLayoutChange}
		class="min-w-0 flex-1"
	>
		<Resizable.Pane
			defaultSize={initialPaneLayout[0]}
			minSize={45}
			order={1}
			class={[
				'flex min-w-0 flex-col',
				!paneDragging && 'transition-[flex-grow] duration-300 ease-out'
			]}
		>
			<header
				class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border px-3 py-3 sm:px-6 md:h-14 md:flex-nowrap md:py-0"
			>
				<!-- Breadcrumb: logo / project ⇅ / branch ⇅. The project crumb is a
				     dropdown over the registry (operators only - data.projects is
				     null for anonymous demo visitors, who get a static crumb), and
				     a branch is never folded into the project name: root and branch
				     are separate segments. -->
				<div class="flex min-w-0 items-center gap-1.5 text-sm">
					<!-- Below lg the sidebar lives behind the hamburger, so the
					     breadcrumb starts with the mark there; on desktop the brand
					     lives top-left in the sidebar and the crumb starts at the
					     project. -->
					<Button
						size="icon"
						variant="ghost"
						class="h-8 w-8 shrink-0 lg:hidden"
						aria-label="Open menu"
						data-testid="mobile-nav-toggle"
						onclick={() => (mobileNavOpen = true)}
					>
						<Menu class="h-4 w-4" />
					</Button>
					<a href={resolve('/')} class="shrink-0 lg:hidden" aria-label="Cloudflarebase home">
						<img src="/brand/mark.svg" alt="" class="h-5 w-5" />
					</a>
					<span class="text-muted-foreground/40 select-none lg:hidden">/</span>
					{#if data.projects}
						<DropdownMenu.Root>
							<DropdownMenu.Trigger>
								{#snippet child({ props })}
									<Button
										{...props}
										size="sm"
										variant="ghost"
										class="h-8 min-w-0 shrink gap-1.5 px-2 font-mono text-xs"
										aria-label="Switch project"
										data-testid="project-switcher"
										data-hydrated={hydrated}
									>
										<span class="truncate" data-testid="project-badge">{rootId}</span>
										<ChevronsUpDown class="h-3 w-3 shrink-0 text-muted-foreground" />
									</Button>
								{/snippet}
							</DropdownMenu.Trigger>
							<DropdownMenu.Content align="start" class="max-h-80 w-64 overflow-y-auto">
								<!-- eslint-disable svelte/no-navigation-without-resolve -- hrefs are resolve()-built project paths -->
								{#each rootProjects as candidate (candidate.id)}
									<DropdownMenu.Item data-testid={`project-item-${candidate.id}`}>
										{#snippet child({ props })}
											<a
												{...props}
												href={resolve('/(app)/dashboard/[projectId]', {
													projectId: candidate.id
												})}
											>
												<span class="truncate font-mono text-xs">{candidate.id}</span>
												{#if candidate.id === rootId}<Check class="ml-auto h-4 w-4" />{/if}
											</a>
										{/snippet}
									</DropdownMenu.Item>
								{/each}
								{#if rootProjects.length}<DropdownMenu.Separator />{/if}
								<DropdownMenu.Item data-testid="project-item-all">
									{#snippet child({ props })}
										<a {...props} href={resolve('/(app)/dashboard')}>
											<LayoutGrid class="h-4 w-4" />
											All projects
										</a>
									{/snippet}
								</DropdownMenu.Item>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
							</DropdownMenu.Content>
						</DropdownMenu.Root>
					{:else}
						<span class="truncate px-1 font-mono text-xs font-medium" data-testid="project-badge"
							>{rootId}</span
						>
					{/if}
					{#if branchCtx}
						{@const ctx = branchCtx}
						<span class="text-muted-foreground/40 select-none">/</span>
						<DropdownMenu.Root>
							<DropdownMenu.Trigger>
								{#snippet child({ props })}
									<Button
										{...props}
										size="sm"
										variant="ghost"
										class="h-8 shrink-0 gap-1.5 px-2 font-mono text-xs"
										aria-label="Switch branch"
										data-testid="branch-switcher"
										data-hydrated={hydrated}
									>
										<GitBranch class="h-3.5 w-3.5 text-muted-foreground" />
										<span class="max-w-24 truncate">{ctx.current ?? 'main'}</span>
										<ChevronsUpDown class="h-3 w-3 shrink-0 text-muted-foreground" />
									</Button>
								{/snippet}
							</DropdownMenu.Trigger>
							<DropdownMenu.Content align="start" class="w-56">
								{@render branchMenuItems(ctx)}
							</DropdownMenu.Content>
						</DropdownMenu.Root>
					{/if}
				</div>

				<div class="ml-auto flex items-center gap-1.5 sm:gap-2">
					{#if claimableDemo}
						<!-- The trial-to-signed-up bridge: the id never changes, so
						     data, users, and integration snippets all survive the
						     claim. Anonymous visitors sign in first and land back
						     here with ?claim=1. -->
						{#if signedIn}
							<Button
								size="sm"
								class="h-8 gap-1.5"
								disabled={claimBusy}
								data-testid="claim-project"
								onclick={() => claimDemo(rootId)}
							>
								<Sparkles class="h-3.5 w-3.5" />
								{claimError ? 'Retry keeping it' : claimBusy ? 'Claiming…' : 'Keep this project'}
							</Button>
						{:else}
							<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve()-built login href with a next param -->
							<Button
								size="sm"
								class="h-8 gap-1.5"
								href={loginClaimHref}
								data-testid="claim-project"
							>
								<Sparkles class="h-3.5 w-3.5" /> Keep this project
							</Button>
						{/if}
					{/if}
					<ModeToggle class="h-8 w-8" testId="theme-toggle" />
				</div>
			</header>
			<!-- Mobile tool navigation lives in the hamburger drawer (the same
			     sidebar aside, fixed-positioned), so no chip row here. -->

			{#if isMobile.current && mobileAgentOpen}
				{@render copilotPanel(false)}
			{:else if isApi}
				<!--
					The API reference owns its scrolling. Scalar pins its sidebar with
					position: sticky against its nearest scroll container, so it needs
					the pane's fixed height and a scrollport of its own - inside the
					shared ScrollArea the page wrapper is content-sized, nothing
					scrolls within it, and the sidebar rides away with the content.
					This mirrors Scalar's official embedded layout: a height-
					constrained container with overflow on the page, not the shell.
				-->
				<main class="min-h-0 min-w-0 flex-1 overflow-hidden bg-muted/20">
					<!-- Keyed per PROJECT, not per path: tool-page hops must not remount
					     and re-play the entry transition (the "shake"). -->
					{#key projectId}
						<div class="h-full" in:fly={{ y: 6, duration: 220, easing: cubicOut, opacity: 0 }}>
							{@render children()}
						</div>
					{/key}
				</main>
			{:else}
				<ScrollArea
					type="always"
					class="min-h-0 min-w-0 flex-1 bg-muted/20"
					scrollbarYClasses="data-vertical:w-1.5 data-vertical:border-l-0"
				>
					<main class="min-w-0">
						<!-- Keyed per PROJECT, not per path: tool-page hops must not remount
					     and re-play the entry transition (the "shake"). -->
						{#key projectId}
							<div
								class="min-h-full"
								in:fly={{ y: 6, duration: 220, easing: cubicOut, opacity: 0 }}
							>
								{@render children()}
							</div>
						{/key}
					</main>
				</ScrollArea>
			{/if}

			<nav class="flex border-t border-border bg-card lg:hidden" aria-label="Project view">
				<button
					type="button"
					class={[
						'flex flex-1 items-center justify-center gap-2 border-t-2 py-2.5 text-sm font-medium transition-colors',
						!mobileAgentOpen
							? 'border-primary text-primary'
							: 'border-transparent text-muted-foreground'
					]}
					aria-pressed={!mobileAgentOpen}
					onclick={() => showMobileAgent(false)}
				>
					<House class="h-4 w-4" /> Backend
				</button>
				<button
					type="button"
					class={[
						'flex flex-1 items-center justify-center gap-2 border-t-2 py-2.5 text-sm font-medium transition-colors',
						mobileAgentOpen
							? 'border-primary text-primary'
							: 'border-transparent text-muted-foreground'
					]}
					aria-pressed={mobileAgentOpen}
					data-testid="mobile-agent-tab"
					onclick={() => showMobileAgent(true)}
				>
					<Sparkles class="h-4 w-4" /> Agent
				</button>
			</nav>
		</Resizable.Pane>

		{#if !isMobile.current}
			<!-- hidden lg:flex kills the SSR flash on phones and portrait tablets:
			     the server always
			     renders this desktop pane (it cannot know the viewport), and CSS
			     hides it at first paint until hydration removes it. The pane stays
			     mounted while closed (collapsed to 0) so collapse/expand can
			     animate via the flex-grow transition. -->
			<Resizable.Handle
				withHandle
				onDraggingChange={(dragging) => (paneDragging = dragging)}
				class={[
					'hidden after:w-2 hover:bg-primary/50 lg:flex [&>div]:h-10 [&>div]:w-1.5',
					!copilotOpen && 'lg:hidden'
				]}
			/>
			<Resizable.Pane
				bind:this={agentPane}
				bind:ref={agentPaneRef}
				defaultSize={copilotOpen ? initialPaneLayout[1] : 0}
				minSize={20}
				maxSize={55}
				collapsible
				collapsedSize={0}
				order={2}
				onCollapse={() => setCopilotOpen(false)}
				onExpand={() => setCopilotOpen(true)}
				class={[
					'hidden min-w-0 flex-col lg:flex',
					!paneDragging && 'transition-[flex-grow] duration-300 ease-out'
				]}
			>
				{@render copilotPanel(true)}
			</Resizable.Pane>
		{/if}
	</Resizable.PaneGroup>

	{#if !isMobile.current && !copilotOpen}
		<div
			class="hidden w-10 shrink-0 flex-col items-center gap-3 border-l border-border bg-background py-3 lg:flex"
			in:fly={{ x: 12, duration: 180, delay: 200, easing: cubicOut }}
			out:fly={{ x: 12, duration: 120, easing: cubicOut }}
		>
			<Button
				size="icon"
				variant="ghost"
				class="h-8 w-8 text-primary"
				onclick={openCopilot}
				data-testid="open-project-copilot"
				aria-label="Open project agent"
			>
				<Sparkles class="h-4 w-4" />
			</Button>
			<span
				class="text-[10px] font-medium tracking-wider text-muted-foreground uppercase [writing-mode:vertical-rl]"
			>
				Agent
			</span>
		</div>
	{/if}
</div>

<Dialog.Root bind:open={newBranchOpen}>
	<Dialog.Content class="sm:max-w-md" data-testid="new-branch-dialog">
		<Dialog.Header>
			<Dialog.Title>New branch</Dialog.Title>
			<Dialog.Description>
				A branch is a fully isolated copy of the whole backend - its own users, collections, tables,
				and keys. It starts empty, like a fresh project.
			</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={createBranch}>
			<div class="space-y-1.5">
				<Label for="new-branch-name">Branch name</Label>
				<Input
					id="new-branch-name"
					data-testid="new-branch-name"
					class="font-mono"
					bind:value={newBranchName}
					oninput={() => (newBranchError = '')}
					placeholder="staging"
					maxlength={maxBranchChars}
					autocomplete="off"
					spellcheck="false"
				/>
				<p class="font-mono text-xs text-muted-foreground" data-testid="new-branch-preview">
					{branchCtx?.rootId}--{newBranchName || '…'}
					<span class="ml-1 text-muted-foreground/60">{newBranchName.length}/{maxBranchChars}</span>
				</p>
			</div>
			{#if newBranchError}
				<p class="text-sm text-destructive" data-testid="new-branch-error">{newBranchError}</p>
			{/if}
			<Dialog.Footer>
				<Button type="submit" disabled={newBranchBusy} data-testid="new-branch-create">
					{newBranchBusy ? 'Creating…' : 'Create branch'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
