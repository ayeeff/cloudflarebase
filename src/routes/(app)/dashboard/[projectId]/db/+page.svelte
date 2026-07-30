<script lang="ts">
	import { dev } from '$app/environment';
	import { page } from '$app/state';
	import type {
		DbAccessMode,
		DbAgentState,
		DbDocument,
		DbOverview,
		DbQueryResult
	} from '$lib/agents';
	import { dbAccessModeSchema } from '$lib/agents';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import * as Select from '$lib/components/ui/select';
	import * as Table from '$lib/components/ui/table';
	import { Textarea } from '$lib/components/ui/textarea';
	import {
		Activity,
		Check,
		Copy,
		Database,
		FileText,
		FolderPlus,
		Plus,
		Radio,
		Rocket,
		ShieldCheck,
		Trash2,
		X
	} from '@lucide/svelte';
	import { AgentClient } from 'agents/client';
	import { onMount } from 'svelte';

	let { data } = $props();
	let hydrated = $state(false);

	onMount(() => {
		hydrated = true;
	});

	// Initial values from the server load; kept in sync on navigation by the
	// $effect below and updated live via WebSocket state sync.
	// svelte-ignore state_referenced_locally
	let overview = $state<DbOverview>(data.overview);
	// svelte-ignore state_referenced_locally
	let agentState = $state<DbAgentState>(data.overview.state);
	let live = $state(false);
	let activeTab = $state('collections');
	let busy = $state(false);

	// Document browser: which collection is open, and its latest page of docs.
	let selected = $state<string | null>(null);
	let documents = $state<DbDocument[]>([]);
	let docsLoaded = $state(false);
	let docsError = $state<string | null>(null);
	let actionError = $state<string | null>(null);

	// Reset local state when navigating between projects.
	$effect(() => {
		overview = data.overview;
		agentState = data.overview.state;
		closeBrowser();
	});

	// Realtime: connect to this project's DbAgent. In dev the agent worker runs
	// on :8789; in production /agents/* is proxied by hooks.server.ts.
	$effect(() => {
		const projectId = data.projectId;
		const client = new AgentClient<DbAgentState>({
			agent: 'db-agent',
			name: projectId,
			host: dev ? 'localhost:8789' : window.location.host,
			onStateUpdate: (state) => {
				agentState = state;
				void refreshData(projectId);
			}
		});
		client.addEventListener('open', () => (live = true));
		client.addEventListener('close', () => (live = false));

		// Polling safety net for when the WebSocket can't connect.
		const poll = setInterval(() => void refreshData(projectId), 5_000);

		return () => {
			clearInterval(poll);
			client.close();
		};
	});

	/** Refetch the overview and, if a collection is open, its documents. */
	async function refreshData(projectId: string) {
		try {
			const response = await fetch(`/api/projects/${projectId}/db/overview`);
			if (projectId !== data.projectId) return;
			if (response.ok) {
				overview = await response.json();
				agentState = overview.state;
			}
		} catch {
			// agent unreachable - keep last snapshot
		}
		if (selected) void loadDocuments(selected);
	}

	async function loadDocuments(collection: string) {
		try {
			const response = await fetch(`/api/projects/${data.projectId}/db/admin/query`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				// orderBy addresses the JSON data only (createdAt is metadata), so
				// the browser takes the agent's default order: document id.
				body: JSON.stringify({ collection, query: { limit: 50 } })
			});
			if (selected !== collection) return;
			const result = (await response.json().catch(() => null)) as
				(DbQueryResult & { error?: string }) | null;
			if (!response.ok || !result) {
				throw new Error(result?.error ?? `request failed (HTTP ${response.status})`);
			}
			documents = result.docs;
			docsError = null;
		} catch (error) {
			if (selected !== collection) return;
			docsError = error instanceof Error ? error.message : String(error);
		} finally {
			if (selected === collection) docsLoaded = true;
		}
	}

	function closeBrowser() {
		selected = null;
		documents = [];
		docsLoaded = false;
		docsError = null;
		actionError = null;
		editorOpen = false;
		docError = null;
	}

	function selectCollection(name: string) {
		if (selected === name) {
			closeBrowser();
			return;
		}
		closeBrowser();
		selected = name;
		void loadDocuments(name);
	}

	// Collection create / access-mode configuration. Both go through the same
	// PUT /admin/collections/:name upsert on the agent.
	const accessModes: DbAccessMode[] = ['public', 'auth', 'owner'];

	function toAccessMode(value: string): DbAccessMode {
		const parsed = dbAccessModeSchema.safeParse(value);
		return parsed.success ? parsed.data : 'owner';
	}

	async function saveCollectionConfig(
		name: string,
		config: { readAccess: DbAccessMode; writeAccess: DbAccessMode }
	): Promise<string | null> {
		try {
			const response = await fetch(
				`/api/projects/${data.projectId}/db/admin/collections/${encodeURIComponent(name)}`,
				{
					method: 'PUT',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(config)
				}
			);
			if (!response.ok) {
				const result = (await response.json().catch(() => null)) as { error?: string } | null;
				throw new Error(result?.error ?? `request failed (HTTP ${response.status})`);
			}
			await refreshData(data.projectId);
			return null;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}

	let newCollectionName = $state('');
	let newReadAccess = $state<DbAccessMode>('public');
	let newWriteAccess = $state<DbAccessMode>('owner');
	let createError = $state<string | null>(null);

	async function createCollection(event: SubmitEvent) {
		event.preventDefault();
		createError = null;
		const name = newCollectionName.trim().toLowerCase();
		// Same rule the agent enforces, validated locally for a readable error.
		if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) {
			createError = 'Collection names are lowercase letters, digits, _ and - (max 64 chars).';
			return;
		}
		busy = true;
		createError = await saveCollectionConfig(name, {
			readAccess: newReadAccess,
			writeAccess: newWriteAccess
		});
		busy = false;
		if (!createError) newCollectionName = '';
	}

	// Access tab: pending edits per collection, applied explicitly per row.
	let accessEdits = $state<Record<string, { readAccess: DbAccessMode; writeAccess: DbAccessMode }>>(
		{}
	);
	let accessFeedback = $state<Record<string, { ok: boolean; message: string }>>({});

	function accessValue(name: string, kind: 'readAccess' | 'writeAccess'): DbAccessMode {
		return (
			accessEdits[name]?.[kind] ??
			agentState.collections.find((collection) => collection.name === name)?.[kind] ??
			'owner'
		);
	}

	function setAccessValue(name: string, kind: 'readAccess' | 'writeAccess', value: DbAccessMode) {
		const pending = {
			readAccess: accessValue(name, 'readAccess'),
			writeAccess: accessValue(name, 'writeAccess')
		};
		pending[kind] = value;
		accessEdits[name] = pending;
	}

	async function applyAccess(name: string) {
		busy = true;
		const message = await saveCollectionConfig(name, {
			readAccess: accessValue(name, 'readAccess'),
			writeAccess: accessValue(name, 'writeAccess')
		});
		busy = false;
		if (message) {
			accessFeedback[name] = { ok: false, message };
			return;
		}
		delete accessEdits[name];
		accessFeedback[name] = { ok: true, message: 'Saved' };
		setTimeout(() => {
			if (accessFeedback[name]?.ok) delete accessFeedback[name];
		}, 2_000);
	}

	// Inline document editor (PUT replaces an existing id, so it doubles as edit).
	let editorOpen = $state(false);
	let docIdInput = $state('');
	let docJsonInput = $state('{ "title": "Ship it", "done": false }');
	let docError = $state<string | null>(null);

	async function saveDocument(event: SubmitEvent) {
		event.preventDefault();
		const collection = selected;
		if (!collection) return;
		docError = null;
		let parsed: unknown;
		try {
			parsed = JSON.parse(docJsonInput);
		} catch (error) {
			docError = `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
			return;
		}
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			docError = 'Document data must be a JSON object.';
			return;
		}
		busy = true;
		try {
			const id = docIdInput.trim() || crypto.randomUUID();
			const response = await fetch(
				`/api/projects/${data.projectId}/db/admin/collections/${encodeURIComponent(collection)}/documents/${encodeURIComponent(id)}`,
				{
					method: 'PUT',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ data: parsed })
				}
			);
			if (!response.ok) {
				const result = (await response.json().catch(() => null)) as { error?: string } | null;
				throw new Error(result?.error ?? `request failed (HTTP ${response.status})`);
			}
			editorOpen = false;
			docIdInput = '';
			await refreshData(data.projectId);
		} catch (error) {
			docError = error instanceof Error ? error.message : String(error);
		} finally {
			busy = false;
		}
	}

	async function deleteDocument(id: string) {
		const collection = selected;
		if (!collection) return;
		if (!confirm('Delete this document? This cannot be undone.')) return;
		busy = true;
		actionError = null;
		try {
			const response = await fetch(
				`/api/projects/${data.projectId}/db/admin/collections/${encodeURIComponent(collection)}/documents/${encodeURIComponent(id)}`,
				{ method: 'DELETE' }
			);
			if (!response.ok) {
				const result = (await response.json().catch(() => null)) as { error?: string } | null;
				throw new Error(result?.error ?? `request failed (HTTP ${response.status})`);
			}
			await refreshData(data.projectId);
		} catch (error) {
			actionError = error instanceof Error ? error.message : String(error);
		} finally {
			busy = false;
		}
	}

	function timeAgo(iso: string): string {
		const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
		if (seconds < 5) return 'just now';
		if (seconds < 60) return `${seconds}s ago`;
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h ago`;
		return `${Math.floor(hours / 24)}d ago`;
	}

	const eventIcons = {
		'project.provisioned': Rocket,
		'collection.created': FolderPlus,
		'collection.deleted': Trash2,
		'collection.configured': ShieldCheck,
		'documents.changed': FileText
	} as const;

	const stats = $derived([
		{
			id: 'collections',
			label: 'Collections',
			value: agentState.collections.length,
			icon: Database
		},
		{ id: 'documents', label: 'Documents', value: agentState.totalDocs, icon: FileText },
		{
			id: 'activity',
			label: 'Last activity',
			value: agentState.lastEventAt ? timeAgo(agentState.lastEventAt) : '—',
			icon: Activity
		}
	]);

	// Integration snippets. page.url.origin is SSR-safe, so these render
	// without a hydration flash.
	const origin = $derived(page.url.origin);
	const dbBase = $derived(`${origin}/api/projects/${data.projectId}/db`);
	const snippets = $derived([
		{
			id: 'rest',
			title: 'REST',
			description:
				'Create a document with curl. Mint a project JWT from the auth agent first - public collections need no token.',
			code: `# A project JWT for the signed-in user (session cookie or bearer token)
curl ${origin}/api/projects/${data.projectId}/auth/token

# Create a document (owner comes from the token subject)
curl -X POST ${dbBase}/collections/todos/documents \\
  -H 'authorization: Bearer <token>' \\
  -H 'content-type: application/json' \\
  -d '{"data":{"title":"Ship it","done":false}}'`
		},
		{
			id: 'sdk',
			title: 'Client SDK',
			description:
				'The typed isomorphic client: CRUD plus live queries that resubscribe and resnapshot on reconnect.',
			code: `import { createDbClient } from '@cloudflarebase/db/client';

const db = createDbClient({
	baseUrl: '${dbBase}',
	getToken: async () => {
		const response = await fetch('${origin}/api/projects/${data.projectId}/auth/token');
		return (await response.json()).token;
	}
});

const todos = db.collection('todos');
await todos.create({ title: 'Ship it', done: false });

const unsubscribe = todos.subscribe(
	{ where: [{ field: 'done', op: '==', value: false }] },
	{
		onSnapshot: (docs) => render(docs),
		onChange: (change, docs) => render(docs)
	}
);`
		},
		{
			id: 'ws',
			title: 'Raw WebSocket',
			description:
				'Subscribe without the SDK: one socket per collection, subscriptions multiplexed by id.',
			code: `const ws = new WebSocket(
	'${origin.replace(/^http/, 'ws')}/agents/db-agent/${data.projectId}/collections/todos/subscribe'
);
ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', id: 'q1', query: { limit: 50 } }));
ws.onmessage = (event) => console.log(JSON.parse(event.data));
// -> { type: 'snapshot', ... } once, then { type: 'change', kind: 'added' | 'modified' | 'removed', ... }`
		}
	]);

	let copiedId = $state<string | null>(null);
	let copyResetTimer: ReturnType<typeof setTimeout> | undefined;

	async function copySnippet(id: string, code: string) {
		try {
			await navigator.clipboard.writeText(code);
			copiedId = id;
			clearTimeout(copyResetTimer);
			copyResetTimer = setTimeout(() => (copiedId = null), 1500);
		} catch {
			// clipboard unavailable - the code stays selectable
		}
	}
</script>

<svelte:head>
	<title>{data.projectId} · Database · Cloudflarebase</title>
	<meta
		name="description"
		content="Browse collections and documents, tune access modes, and connect apps to project {data.projectId}'s database."
	/>
</svelte:head>

<div
	class="mx-auto max-w-7xl space-y-5 px-3 py-5 sm:space-y-6 sm:px-6 sm:py-8"
	data-testid="db-page"
	data-hydrated={hydrated}
>
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div>
			<h1 class="text-2xl font-semibold">Database</h1>
			<p class="mt-1 text-sm text-muted-foreground">
				Served by this project's DbAgent - JSON documents with live queries, one Durable Object per
				collection.
			</p>
		</div>
		<Badge variant="outline" class="gap-1.5" data-testid="connection-status">
			<span
				class={[
					'h-1.5 w-1.5 rounded-full',
					live ? 'animate-pulse bg-emerald-500' : 'bg-muted-foreground/40'
				]}
			></span>
			{live ? 'realtime' : 'polling'}
		</Badge>
	</div>

	<div>
		<div class="flex h-10 max-w-full gap-1 overflow-x-auto border-b px-1" role="tablist">
			{#each [['collections', 'Collections'], ['access', 'Access'], ['setup', 'Integration']] as tab (tab[0])}
				<button
					type="button"
					role="tab"
					aria-selected={activeTab === tab[0]}
					class={[
						'relative flex-none px-3.5 text-sm font-medium transition-colors',
						activeTab === tab[0]
							? 'text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-primary'
							: 'text-muted-foreground hover:text-foreground'
					]}
					onclick={() => (activeTab = tab[0])}>{tab[1]}</button
				>
			{/each}
		</div>

		<!-- COLLECTIONS -->
		{#if activeTab === 'collections'}
			<div class="mt-4 space-y-5 sm:space-y-6">
				<div class="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
					{#each stats as stat (stat.id)}
						<Card.Root class="py-4" data-testid={`db-stat-${stat.id}`}>
							<Card.Content class="flex items-center justify-between gap-2 px-3 sm:px-5">
								<div>
									<p class="text-xs tracking-wide text-muted-foreground uppercase">{stat.label}</p>
									<p class="mt-1 text-2xl font-semibold tabular-nums" data-testid="stat-value">
										{stat.value}
									</p>
								</div>
								<div
									class="hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary min-[360px]:flex"
								>
									<stat.icon class="h-4.5 w-4.5" strokeWidth={1.8} />
								</div>
							</Card.Content>
						</Card.Root>
					{/each}
				</div>

				<div class="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
					<Card.Root class="min-w-0 lg:col-span-2" data-testid="db-collections-card">
						<Card.Header>
							<Card.Title>Collections</Card.Title>
							<Card.Description>Click a collection to browse its documents.</Card.Description>
						</Card.Header>
						<Card.Content>
							{#if agentState.collections.length === 0}
								<p
									class="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground"
								>
									No collections yet - create the first one below.
								</p>
							{:else}
								<Table.Root class="min-w-[36rem]" data-testid="db-collections-table">
									<Table.Header>
										<Table.Row>
											<Table.Head>Name</Table.Head>
											<Table.Head>Read</Table.Head>
											<Table.Head>Write</Table.Head>
											<Table.Head class="text-right">Documents</Table.Head>
										</Table.Row>
									</Table.Header>
									<Table.Body>
										{#each agentState.collections as collection (collection.name)}
											<Table.Row
												class={['cursor-pointer', selected === collection.name && 'bg-muted/50']}
												data-testid={`db-collection-${collection.name}`}
												onclick={() => selectCollection(collection.name)}
											>
												<Table.Cell>
													<div class="flex items-center gap-2">
														<div
															class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
														>
															<Database class="h-3.5 w-3.5" />
														</div>
														<span class="font-mono text-sm font-medium">{collection.name}</span>
													</div>
												</Table.Cell>
												<Table.Cell>
													<Badge variant="outline" class="font-mono text-[11px]">
														{collection.readAccess}
													</Badge>
												</Table.Cell>
												<Table.Cell>
													<Badge variant="outline" class="font-mono text-[11px]">
														{collection.writeAccess}
													</Badge>
												</Table.Cell>
												<Table.Cell class="text-right text-sm tabular-nums">
													{collection.docs}
												</Table.Cell>
											</Table.Row>
										{/each}
									</Table.Body>
								</Table.Root>
							{/if}

							<form
								class="mt-4 flex flex-wrap items-end gap-3 rounded-lg border bg-muted/20 p-4"
								data-testid="db-create-collection"
								onsubmit={createCollection}
							>
								<div class="min-w-40 flex-1 space-y-2">
									<Label for="new-collection-name">New collection</Label>
									<Input
										id="new-collection-name"
										class="font-mono"
										placeholder="todos"
										bind:value={newCollectionName}
									/>
								</div>
								<div class="space-y-2">
									<Label>Read</Label>
									<Select.Root
										type="single"
										value={newReadAccess}
										onValueChange={(value) => (newReadAccess = toAccessMode(value))}
									>
										<Select.Trigger
											class="min-w-24 font-mono"
											size="sm"
											aria-label="Read access for the new collection"
										>
											{newReadAccess}
										</Select.Trigger>
										<Select.Content>
											{#each accessModes as mode (mode)}
												<Select.Item value={mode} label={mode} class="font-mono" />
											{/each}
										</Select.Content>
									</Select.Root>
								</div>
								<div class="space-y-2">
									<Label>Write</Label>
									<Select.Root
										type="single"
										value={newWriteAccess}
										onValueChange={(value) => (newWriteAccess = toAccessMode(value))}
									>
										<Select.Trigger
											class="min-w-24 font-mono"
											size="sm"
											aria-label="Write access for the new collection"
										>
											{newWriteAccess}
										</Select.Trigger>
										<Select.Content>
											{#each accessModes as mode (mode)}
												<Select.Item value={mode} label={mode} class="font-mono" />
											{/each}
										</Select.Content>
									</Select.Root>
								</div>
								<Button type="submit" size="sm" class="gap-1.5" disabled={busy}>
									<Plus class="h-4 w-4" /> Create
								</Button>
								{#if createError}
									<p class="basis-full text-sm text-destructive" data-testid="db-create-error">
										{createError}
									</p>
								{/if}
							</form>
						</Card.Content>
					</Card.Root>

					<Card.Root data-testid="db-activity">
						<Card.Header>
							<Card.Title class="flex items-center gap-2">
								<Radio class="h-4 w-4 text-primary" /> Live activity
							</Card.Title>
							<Card.Description>Streamed from the agent via WebSocket state sync.</Card.Description>
						</Card.Header>
						<Card.Content>
							{#if agentState.events.length === 0}
								<p class="py-6 text-center text-sm text-muted-foreground">Nothing yet.</p>
							{:else}
								<ScrollArea class="h-72 pr-3" type="always">
									<ol class="space-y-4">
										{#each agentState.events as event (event.id)}
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
				</div>

				{#if selected}
					<Card.Root data-testid="db-documents-card">
						<Card.Header>
							<Card.Title class="font-mono">{selected}</Card.Title>
							<Card.Description>
								Up to 50 documents in id order, refetched on every change. Saving to an existing id
								replaces that document.
							</Card.Description>
							<Card.Action class="flex items-center gap-2 self-center">
								<Button
									size="sm"
									class="gap-1.5"
									data-testid="db-add-document"
									onclick={() => {
										editorOpen = !editorOpen;
										docError = null;
									}}
								>
									<Plus class="h-4 w-4" /> Add document
								</Button>
								<Button
									variant="ghost"
									size="icon"
									class="h-8 w-8"
									aria-label="Close document browser"
									onclick={closeBrowser}
								>
									<X class="h-4 w-4" />
								</Button>
							</Card.Action>
						</Card.Header>
						<Card.Content>
							{#if editorOpen}
								<form
									class="mb-4 space-y-3 rounded-lg border bg-muted/20 p-4"
									data-testid="db-doc-editor"
									onsubmit={saveDocument}
								>
									<div class="grid gap-3 sm:grid-cols-2">
										<div class="space-y-2">
											<Label for="doc-id">Document id (optional)</Label>
											<Input
												id="doc-id"
												class="font-mono"
												placeholder="auto-generated"
												bind:value={docIdInput}
											/>
										</div>
									</div>
									<div class="space-y-2">
										<Label for="doc-json">Data (JSON object)</Label>
										<Textarea
											id="doc-json"
											class="min-h-32 font-mono text-xs"
											bind:value={docJsonInput}
										/>
									</div>
									{#if docError}
										<p class="text-sm text-destructive" data-testid="db-doc-error">{docError}</p>
									{/if}
									<div class="flex gap-2">
										<Button type="submit" size="sm" disabled={busy}>Save document</Button>
										<Button
											type="button"
											variant="ghost"
											size="sm"
											onclick={() => (editorOpen = false)}
										>
											Cancel
										</Button>
									</div>
								</form>
							{/if}

							{#if actionError}
								<p class="mb-3 text-sm text-destructive" data-testid="db-action-error">
									{actionError}
								</p>
							{/if}
							{#if docsError}
								<p class="mb-3 text-sm text-destructive" data-testid="db-docs-error">{docsError}</p>
							{/if}

							{#if !docsLoaded}
								<p class="py-6 text-center text-sm text-muted-foreground">Loading documents…</p>
							{:else if documents.length === 0}
								<p
									class="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground"
								>
									No documents yet - add the first one.
								</p>
							{:else}
								<Table.Root class="min-w-[42rem]" data-testid="db-documents-table">
									<Table.Header>
										<Table.Row>
											<Table.Head>Id</Table.Head>
											<Table.Head>Data</Table.Head>
											<Table.Head>Owner</Table.Head>
											<Table.Head class="text-right">Updated</Table.Head>
											<Table.Head class="w-12"><span class="sr-only">Actions</span></Table.Head>
										</Table.Row>
									</Table.Header>
									<Table.Body>
										{#each documents as doc (doc.id)}
											<Table.Row>
												<Table.Cell class="max-w-40 truncate font-mono text-xs" title={doc.id}>
													{doc.id}
												</Table.Cell>
												<Table.Cell class="max-w-80">
													<code
														class="block truncate font-mono text-xs text-muted-foreground"
														title={JSON.stringify(doc.data)}
													>
														{JSON.stringify(doc.data)}
													</code>
												</Table.Cell>
												<Table.Cell
													class="max-w-32 truncate font-mono text-xs text-muted-foreground"
													title={doc.owner ?? ''}
												>
													{doc.owner ?? '—'}
												</Table.Cell>
												<Table.Cell class="text-right text-xs text-muted-foreground">
													{timeAgo(doc.updatedAt)}
												</Table.Cell>
												<Table.Cell>
													<Button
														variant="ghost"
														size="icon"
														class="h-8 w-8 text-muted-foreground hover:text-destructive"
														disabled={busy}
														aria-label={`Delete document ${doc.id}`}
														onclick={() => deleteDocument(doc.id)}
													>
														<Trash2 class="h-4 w-4" />
													</Button>
												</Table.Cell>
											</Table.Row>
										{/each}
									</Table.Body>
								</Table.Root>
							{/if}
						</Card.Content>
					</Card.Root>
				{/if}
			</div>
		{/if}

		<!-- ACCESS -->
		{#if activeTab === 'access'}
			<div class="mt-4">
				<Card.Root data-testid="db-access-modes">
					<Card.Header>
						<Card.Title>Access modes</Card.Title>
						<Card.Description>
							public - anyone; auth - any valid project JWT; owner - reads and writes scoped to the
							token subject.
						</Card.Description>
					</Card.Header>
					<Card.Content>
						{#if agentState.collections.length === 0}
							<p
								class="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground"
							>
								No collections yet - create one under Collections.
							</p>
						{:else}
							<Table.Root class="min-w-[36rem]">
								<Table.Header>
									<Table.Row>
										<Table.Head>Collection</Table.Head>
										<Table.Head>Read</Table.Head>
										<Table.Head>Write</Table.Head>
										<Table.Head class="w-40 text-right">
											<span class="sr-only">Actions</span>
										</Table.Head>
									</Table.Row>
								</Table.Header>
								<Table.Body>
									{#each agentState.collections as collection (collection.name)}
										{@const feedback = accessFeedback[collection.name]}
										<Table.Row data-testid={`db-access-${collection.name}`}>
											<Table.Cell class="font-mono text-sm font-medium">
												{collection.name}
											</Table.Cell>
											<Table.Cell>
												<Select.Root
													type="single"
													value={accessValue(collection.name, 'readAccess')}
													onValueChange={(value) =>
														setAccessValue(collection.name, 'readAccess', toAccessMode(value))}
												>
													<Select.Trigger
														class="min-w-24 font-mono"
														size="sm"
														disabled={busy}
														aria-label={`Read access for ${collection.name}`}
													>
														{accessValue(collection.name, 'readAccess')}
													</Select.Trigger>
													<Select.Content>
														{#each accessModes as mode (mode)}
															<Select.Item value={mode} label={mode} class="font-mono" />
														{/each}
													</Select.Content>
												</Select.Root>
											</Table.Cell>
											<Table.Cell>
												<Select.Root
													type="single"
													value={accessValue(collection.name, 'writeAccess')}
													onValueChange={(value) =>
														setAccessValue(collection.name, 'writeAccess', toAccessMode(value))}
												>
													<Select.Trigger
														class="min-w-24 font-mono"
														size="sm"
														disabled={busy}
														aria-label={`Write access for ${collection.name}`}
													>
														{accessValue(collection.name, 'writeAccess')}
													</Select.Trigger>
													<Select.Content>
														{#each accessModes as mode (mode)}
															<Select.Item value={mode} label={mode} class="font-mono" />
														{/each}
													</Select.Content>
												</Select.Root>
											</Table.Cell>
											<Table.Cell>
												<div class="flex items-center justify-end gap-2">
													{#if feedback}
														<span
															class={[
																'text-xs',
																feedback.ok
																	? 'text-emerald-600 dark:text-emerald-400'
																	: 'text-destructive'
															]}
														>
															{feedback.message}
														</span>
													{/if}
													<Button
														size="sm"
														variant="outline"
														disabled={busy || !accessEdits[collection.name]}
														onclick={() => applyAccess(collection.name)}
													>
														Apply
													</Button>
												</div>
											</Table.Cell>
										</Table.Row>
									{/each}
								</Table.Body>
							</Table.Root>
						{/if}
					</Card.Content>
				</Card.Root>
			</div>
		{/if}

		<!-- INTEGRATION -->
		{#if activeTab === 'setup'}
			<div class="mt-4">
				<Card.Root data-testid="db-integration">
					<Card.Header>
						<Card.Title>Connect your application</Card.Title>
						<Card.Description>
							REST with project JWTs, the typed client SDK, or a raw live-query WebSocket.
						</Card.Description>
					</Card.Header>
					<Card.Content class="space-y-5">
						<div>
							<Label>Database base URL</Label><code
								class="mt-2 block overflow-x-auto rounded-lg border bg-muted/50 p-3 text-xs"
								>{dbBase}</code
							>
						</div>
						{#each snippets as snippet (snippet.id)}
							<div>
								<Label>{snippet.title}</Label>
								<p class="mt-1 text-xs text-muted-foreground">{snippet.description}</p>
								<div class="relative mt-2">
									<Button
										variant="ghost"
										size="icon"
										class="absolute top-2 right-2 z-10 h-7 w-7 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
										aria-label={`Copy ${snippet.title} example`}
										data-testid={`copy-${snippet.id}`}
										onclick={() => copySnippet(snippet.id, snippet.code)}
									>
										{#if copiedId === snippet.id}
											<Check class="h-3.5 w-3.5" />
										{:else}
											<Copy class="h-3.5 w-3.5" />
										{/if}
									</Button>
									<pre
										class="overflow-x-auto rounded-lg border bg-zinc-950 p-4 text-xs leading-relaxed text-zinc-100"><code
											>{snippet.code}</code
										></pre>
								</div>
							</div>
						{/each}
						<p class="text-xs text-muted-foreground">
							auth and owner collections need a project JWT from the auth agent; external browser
							applications must be listed under the project's allowed origins.
						</p>
					</Card.Content>
				</Card.Root>
			</div>
		{/if}
	</div>
</div>
