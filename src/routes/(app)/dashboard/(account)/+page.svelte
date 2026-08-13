<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { CONSOLE_AUTH_BASE } from '$lib/console';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { projectIdSchema } from '$lib/schemas/auth';
	import { ChevronRight, Database, GitBranch, Mail, Plus } from '@lucide/svelte';

	let { data } = $props();

	// The create form lives in a dialog behind the "+ New project" button
	// (Supabase-style); the empty state opens the same dialog.
	let createOpen = $state(false);

	let inviteBusy = $state<string | null>(null);

	async function answerInvitation(invitationId: string, accept: boolean) {
		if (inviteBusy) return;
		inviteBusy = invitationId;
		try {
			await fetch(
				`${CONSOLE_AUTH_BASE}/organization/${accept ? 'accept-invitation' : 'reject-invitation'}`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ invitationId })
				}
			);
			await invalidateAll();
		} finally {
			inviteBusy = null;
		}
	}

	// Branches group under their root project instead of listing as siblings
	// (docs/branches-design.md). parentId decides - never the id's shape, so
	// grandfathered roots containing `--` stay top-level. A branch whose root
	// row is somehow missing degrades to a top-level row rather than vanishing.
	const rootIds = $derived(
		data.projects.filter((project) => !project.parentId).map((project) => project.id)
	);
	const groups = $derived(
		data.projects
			.filter((project) => !project.parentId || !rootIds.includes(project.parentId))
			.map((root) => ({
				root,
				branches: data.projects.filter((branch) => branch.parentId === root.id)
			}))
	);

	let name = $state('');
	let id = $state('');
	let error = $state<string | null>(null);
	let creating = $state(false);

	// Suggest an id from the name until the operator types their own.
	let idTouched = $state(false);
	const suggestedId = $derived(
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 32)
	);
	const effectiveId = $derived(idTouched ? id : suggestedId);

	async function create(event: SubmitEvent) {
		event.preventDefault();
		error = null;

		const parsed = projectIdSchema.safeParse(effectiveId);
		if (!parsed.success) {
			error = parsed.error.issues[0]?.message ?? 'Invalid project id.';
			return;
		}

		creating = true;
		try {
			const response = await fetch('/api/registry/projects', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ id: parsed.data, name: name.trim() || parsed.data })
			});

			if (!response.ok) {
				const body = (await response.json().catch(() => null)) as { error?: string } | null;
				error = body?.error ?? 'Could not create the project.';
				return;
			}

			await invalidateAll();
			await goto(resolve('/(app)/dashboard/[projectId]', { projectId: parsed.data }));
		} finally {
			creating = false;
		}
	}
</script>

<svelte:head>
	<title>Projects · Cloudflarebase</title>
</svelte:head>

<div class="space-y-8">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div class="space-y-1.5">
			<h1 class="text-2xl font-semibold tracking-tight">Projects</h1>
			<p class="text-sm text-muted-foreground">
				Each project runs its own agent, backed by its own database.
			</p>
		</div>
		<Button
			class="gap-1.5"
			data-testid="new-project"
			onclick={() => {
				error = null;
				createOpen = true;
			}}
		>
			<Plus class="h-4 w-4" /> New project
		</Button>
	</div>

	{#each data.pendingInvitations as invitation (invitation.id)}
		<div
			class="flex flex-wrap items-center gap-3 rounded-lg border border-primary/40 bg-primary/5 p-4"
			data-testid="pending-invitation"
		>
			<Mail class="h-5 w-5 shrink-0 text-primary" />
			<div class="min-w-0 flex-1">
				<p class="text-sm font-medium">
					You have been invited to <span class="font-semibold">{invitation.organizationName}</span>
				</p>
				{#if invitation.inviterEmail}
					<p class="truncate text-xs text-muted-foreground">
						Invited by {invitation.inviterEmail}
					</p>
				{/if}
			</div>
			<div class="flex shrink-0 gap-2">
				<Button
					size="sm"
					disabled={inviteBusy === invitation.id}
					data-testid="accept-invitation"
					onclick={() => answerInvitation(invitation.id, true)}
				>
					Accept
				</Button>
				<Button
					size="sm"
					variant="outline"
					disabled={inviteBusy === invitation.id}
					onclick={() => answerInvitation(invitation.id, false)}
				>
					Decline
				</Button>
			</div>
		</div>
	{/each}

	{#if data.projects.length}
		<div class="grid gap-2" data-testid="project-list">
			{#each groups as { root: project, branches } (project.id)}
				<a
					href={resolve('/(app)/dashboard/[projectId]', { projectId: project.id })}
					class="group flex items-center gap-3 rounded-lg border bg-card p-4 transition-colors hover:border-primary hover:bg-accent/40"
				>
					<Database class="h-5 w-5 shrink-0 text-muted-foreground" />
					<div class="min-w-0 flex-1">
						<p class="truncate font-medium">{project.name}</p>
						<p class="truncate font-mono text-xs text-muted-foreground">{project.id}</p>
					</div>
					{#if branches.length}
						<Badge variant="outline" class="shrink-0 gap-1 text-xs text-muted-foreground">
							<GitBranch class="h-3 w-3" />
							{branches.length}
							{branches.length === 1 ? 'branch' : 'branches'}
						</Badge>
					{/if}
					<ChevronRight
						class="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
					/>
				</a>
				{#each branches as branch (branch.id)}
					<a
						href={resolve('/(app)/dashboard/[projectId]', { projectId: branch.id })}
						class="group ml-7 flex items-center gap-3 rounded-lg border bg-card p-3 transition-colors hover:border-primary hover:bg-accent/40"
						data-testid="branch-row"
					>
						<GitBranch class="h-4 w-4 shrink-0 text-muted-foreground" />
						<div class="min-w-0 flex-1">
							<p class="truncate font-mono text-sm font-medium">{branch.branchName}</p>
							<p class="truncate font-mono text-xs text-muted-foreground">{branch.id}</p>
						</div>
						<ChevronRight
							class="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
						/>
					</a>
				{/each}
			{/each}
		</div>
	{/if}

	{#if !data.projects.length}
		<Card.Root class="border-dashed">
			<Card.Content class="flex flex-col items-center gap-3 py-12 text-center">
				<Database class="h-8 w-8 text-muted-foreground/60" />
				<div class="space-y-1">
					<p class="font-medium">No projects yet</p>
					<p class="text-sm text-muted-foreground">
						Each project runs its own agents with their own databases.
					</p>
				</div>
				<Button
					class="mt-2 gap-1.5"
					data-testid="create-first-project"
					onclick={() => {
						error = null;
						createOpen = true;
					}}
				>
					<Plus class="h-4 w-4" /> Create your first project
				</Button>
			</Card.Content>
		</Card.Root>
	{/if}
</div>

<Dialog.Root bind:open={createOpen}>
	<Dialog.Content data-testid="create-project">
		<Dialog.Header>
			<Dialog.Title>New project</Dialog.Title>
			<Dialog.Description>
				The id becomes the project's Durable Object name and its API base path - it cannot be
				changed later.
			</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={create}>
			<div class="grid gap-4 sm:grid-cols-2">
				<div class="space-y-1.5">
					<Label for="project-name">Name</Label>
					<Input id="project-name" bind:value={name} placeholder="My app" required />
				</div>

				<div class="space-y-1.5">
					<Label for="project-id">Project id</Label>
					<Input
						id="project-id"
						class="font-mono"
						value={effectiveId}
						oninput={(event) => {
							idTouched = true;
							id = event.currentTarget.value;
						}}
						placeholder="my-app"
						required
					/>
				</div>
			</div>

			{#if error}
				<p class="text-sm text-destructive" data-testid="create-project-error">{error}</p>
			{/if}

			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (createOpen = false)}>Cancel</Button>
				<Button type="submit" disabled={creating}>
					{creating ? 'Creating…' : 'Create project'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
