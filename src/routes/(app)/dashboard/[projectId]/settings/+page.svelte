<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { GitBranch, Settings, TriangleAlert } from '@lucide/svelte';

	let { data } = $props();

	const isBranch = $derived(!!data.project?.parentId);

	// Initial-value capture on purpose; renaming re-syncs via invalidateAll.
	// svelte-ignore state_referenced_locally
	let projectName = $state(data.project?.name ?? '');
	let renameBusy = $state(false);
	let renameError = $state<string | null>(null);
	let renameSaved = $state(false);

	async function rename(event: SubmitEvent) {
		event.preventDefault();
		renameBusy = true;
		renameError = null;
		renameSaved = false;
		try {
			const response = await fetch(`/api/registry/projects/${data.projectId}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: projectName.trim() })
			});
			if (!response.ok) {
				const body = (await response.json().catch(() => null)) as { error?: string } | null;
				renameError = body?.error ?? 'Could not rename the project.';
				return;
			}
			renameSaved = true;
			await invalidateAll();
		} catch {
			renameError = 'Could not reach the control plane.';
		} finally {
			renameBusy = false;
		}
	}

	// Delete (typed-id confirmation, like the table and collection panels).
	let deleteOpen = $state(false);
	let deleteConfirm = $state('');
	let deleteError = $state<string | null>(null);
	let deleteBusy = $state(false);

	async function deleteProject() {
		if (deleteConfirm !== data.projectId) return;
		deleteBusy = true;
		deleteError = null;
		try {
			const response = await fetch(`/api/registry/projects/${data.projectId}`, {
				method: 'DELETE'
			});
			// 207: the registration is gone but an agent kept data - the project
			// is deleted from the console's point of view either way.
			if (!response.ok && response.status !== 207) {
				const body = (await response.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? `request failed (HTTP ${response.status})`);
			}
			deleteOpen = false;
			await goto(resolve('/(app)/dashboard/(account)'), { invalidateAll: true });
		} catch (error) {
			deleteError = error instanceof Error ? error.message : String(error);
		} finally {
			deleteBusy = false;
		}
	}
</script>

<svelte:head>
	<title>Settings · {data.projectId} · Cloudflarebase</title>
</svelte:head>

<div class="mx-auto w-full max-w-3xl space-y-6 px-4 py-8 sm:px-8" data-testid="settings-page">
	<div class="flex items-center gap-3">
		<Settings class="h-6 w-6 text-muted-foreground" />
		<div>
			<h1 class="text-2xl font-semibold tracking-tight">Settings</h1>
			<p class="font-mono text-xs text-muted-foreground">{data.projectId}</p>
		</div>
	</div>

	{#if !data.project}
		<Card.Root>
			<Card.Header>
				<Card.Title class="text-base">Not a registered project</Card.Title>
				<Card.Description>
					This id has no registry row to manage - demo projects are throwaway and expire on their
					own. Create a real project from the projects overview to get settings.
				</Card.Description>
			</Card.Header>
		</Card.Root>
	{:else}
		<Card.Root>
			<Card.Header>
				<Card.Title class="text-base">General</Card.Title>
				<Card.Description>
					The name is display-only. The id is the project's Durable Object name and its API base
					path - it cannot be changed.
				</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-4">
				<form class="flex flex-wrap items-end gap-3" onsubmit={rename}>
					<div class="min-w-56 flex-1 space-y-1.5">
						<Label for="project-name">Name</Label>
						<Input id="project-name" bind:value={projectName} required maxlength={64} />
					</div>
					<Button
						type="submit"
						variant="outline"
						disabled={renameBusy}
						data-testid="rename-project"
					>
						{renameBusy ? 'Saving…' : 'Save'}
					</Button>
				</form>
				{#if renameError}
					<p class="text-sm text-destructive" data-testid="rename-project-error">{renameError}</p>
				{:else if renameSaved}
					<p class="text-sm text-muted-foreground">Saved.</p>
				{/if}

				<dl class="grid gap-3 text-sm sm:grid-cols-2">
					<div>
						<dt class="text-xs text-muted-foreground">Project id</dt>
						<dd class="font-mono">{data.project.id}</dd>
					</div>
					<div>
						<dt class="text-xs text-muted-foreground">Created</dt>
						<dd>{new Date(data.project.createdAt).toLocaleDateString()}</dd>
					</div>
					{#if isBranch}
						<div class="sm:col-span-2">
							<dt class="text-xs text-muted-foreground">Branch</dt>
							<dd class="flex items-center gap-1.5">
								<GitBranch class="h-3.5 w-3.5 text-muted-foreground" />
								<span class="font-mono">{data.project.branchName}</span>
								<span class="text-muted-foreground">of</span>
								<span class="font-mono">{data.project.parentId}</span>
							</dd>
						</div>
					{/if}
				</dl>
			</Card.Content>
		</Card.Root>

		<Card.Root class="border-destructive/40">
			<Card.Header>
				<Card.Title class="flex items-center gap-2 text-base text-destructive">
					<TriangleAlert class="h-4 w-4" /> Danger zone
				</Card.Title>
				<Card.Description>
					{isBranch
						? 'Deleting this branch erases its users, data, and deploys. The root project is untouched.'
						: 'Deleting this project erases its users, data, and deploys in every agent - branches included.'}
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<Button
					variant="destructive"
					onclick={() => {
						deleteConfirm = '';
						deleteError = null;
						deleteOpen = true;
					}}
					data-testid="delete-project"
				>
					{isBranch ? 'Delete branch' : 'Delete project'}
				</Button>
			</Card.Content>
		</Card.Root>
	{/if}
</div>

<Dialog.Root bind:open={deleteOpen}>
	<Dialog.Content data-testid="delete-project-panel">
		<Dialog.Header>
			<Dialog.Title>Delete "{data.projectId}"?</Dialog.Title>
			<Dialog.Description>
				{isBranch
					? 'The branch and everything in it are erased. This cannot be undone.'
					: 'The project, its branches, and everything in them are erased. This cannot be undone.'}
				Type the project id to confirm.
			</Dialog.Description>
		</Dialog.Header>
		<Input
			bind:value={deleteConfirm}
			class="font-mono"
			placeholder={data.projectId}
			autocomplete="off"
			data-testid="delete-project-confirm"
		/>
		{#if deleteError}
			<p class="text-sm text-destructive">{deleteError}</p>
		{/if}
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (deleteOpen = false)}>Cancel</Button>
			<Button
				variant="destructive"
				disabled={deleteBusy || deleteConfirm !== data.projectId}
				onclick={() => void deleteProject()}
				data-testid="delete-project-submit"
			>
				{deleteBusy ? 'Deleting…' : isBranch ? 'Delete branch' : 'Delete project'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
