<script lang="ts">
	import {
		dbRemoteConfigSchema,
		dbRestorePointsSchema,
		type DbRemoteConfigParameter,
		type DbRestorePoint
	} from '$lib/agents';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Select from '$lib/components/ui/select';
	import * as Table from '$lib/components/ui/table';
	import { Textarea } from '$lib/components/ui/textarea';
	import {
		History,
		LoaderCircle,
		Pencil,
		Plus,
		RotateCcw,
		SlidersHorizontal,
		Trash2,
		Undo2,
		Upload
	} from '@lucide/svelte';
	import { onMount } from 'svelte';

	/**
	 * Remote Config - server-controlled parameters an app reads at startup:
	 * feature flags, kill switches, tuning values, changed without a redeploy.
	 *
	 * The interaction is Firebase's, and for Firebase's reason: edits are a
	 * DRAFT and publishing is what reaches clients. A config change usually
	 * means several parameters moving together, so an operator halfway through
	 * editing must never be serving a half-changed config to everyone. That is
	 * why the primary action in this page's header is Publish, why it counts
	 * what is pending, and why Discard exists beside it.
	 *
	 * Nothing here configures access, because there is nothing to configure: the
	 * parameters live in a platform-owned table closed on both sides, and RC2's
	 * public endpoint will serve them EVALUATED - so the raw parameters never
	 * leave the server even once clients can read their values.
	 */

	let { data } = $props();

	const VALUE_TYPES = ['string', 'number', 'boolean', 'json'] as const;
	type ValueType = (typeof VALUE_TYPES)[number];

	const base = $derived(`/api/projects/${data.projectId}/db/admin/remote-config`);

	let parameters = $state<DbRemoteConfigParameter[]>([]);
	let pendingChanges = $state(0);
	let everPublished = $state(false);
	let limit = $state(100);
	let versions = $state<DbRestorePoint[]>([]);
	let versionsSupported = $state(true);
	let loading = $state(true);
	let busy = $state(false);
	let error = $state('');
	let notice = $state('');

	let editorOpen = $state(false);
	let confirmDiscard = $state(false);
	let rollbackTarget = $state<DbRestorePoint | null>(null);

	/** The key being edited; empty means this is a new parameter. */
	let editingKey = $state('');
	let draftKey = $state('');
	let draftType = $state<ValueType>('boolean');
	/**
	 * Always edited as TEXT, whatever the declared type, and parsed on save. An
	 * input that re-parses per keystroke fights the person typing `-` before a
	 * number or `{` before a JSON object.
	 */
	let draftValue = $state('false');
	let draftDescription = $state('');
	let draftError = $state('');

	async function load() {
		error = '';
		try {
			const [configResponse, versionsResponse] = await Promise.all([
				fetch(base),
				fetch(`${base}/versions`)
			]);
			if (!configResponse.ok) {
				const payload = (await configResponse.json().catch(() => null)) as {
					error?: string;
				} | null;
				error = payload?.error ?? 'could not load Remote Config';
				return;
			}
			const parsed = dbRemoteConfigSchema.safeParse(await configResponse.json());
			if (!parsed.success) {
				error = 'the db agent returned an unexpected shape';
				return;
			}
			parameters = parsed.data.parameters;
			pendingChanges = parsed.data.pendingChanges;
			everPublished = parsed.data.everPublished;
			limit = parsed.data.limit;

			// Versions are a nicety: local development has no point-in-time
			// recovery at all, and that must not take the editor down with it.
			if (versionsResponse.ok) {
				const points = dbRestorePointsSchema.safeParse(await versionsResponse.json());
				if (points.success) {
					versions = points.data.points;
					versionsSupported = points.data.supported;
				}
			} else {
				versionsSupported = false;
			}
		} catch {
			error = 'could not reach the db agent';
		} finally {
			loading = false;
		}
	}

	onMount(load);

	function openNew() {
		editingKey = '';
		draftKey = '';
		draftType = 'boolean';
		draftValue = 'false';
		draftDescription = '';
		draftError = '';
		editorOpen = true;
	}

	function openEdit(parameter: DbRemoteConfigParameter) {
		editingKey = parameter.key;
		draftKey = parameter.key;
		draftType = parameter.valueType;
		draftValue =
			parameter.valueType === 'string'
				? String(parameter.draftValue ?? '')
				: JSON.stringify(parameter.draftValue ?? null);
		draftDescription = parameter.description ?? '';
		draftError = '';
		editorOpen = true;
	}

	/**
	 * Text -> the typed value the agent expects. A string takes the raw text -
	 * quoting your own strings is a papercut nobody wants - and every other type
	 * is JSON, which is what makes `null` expressible at all.
	 */
	function parseDraft(): { ok: true; value: unknown } | { ok: false; error: string } {
		if (draftType === 'string') return { ok: true, value: draftValue };
		const text = draftValue.trim();
		if (!text) return { ok: false, error: 'a value is required' };
		try {
			return { ok: true, value: JSON.parse(text) as unknown };
		} catch {
			return {
				ok: false,
				error:
					draftType === 'json'
						? 'that is not valid JSON - try {"a": 1}, [1, 2], or null'
						: `that is not a valid ${draftType}`
			};
		}
	}

	async function send(path: string, init: RequestInit): Promise<Record<string, unknown> | null> {
		const response = await fetch(path, {
			...init,
			headers: init.body ? { 'content-type': 'application/json' } : undefined
		});
		const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
		if (!response.ok) {
			error = (payload?.error as string) ?? 'that did not work';
			return null;
		}
		return payload ?? {};
	}

	async function save() {
		draftError = '';
		const parsed = parseDraft();
		if (!parsed.ok) {
			draftError = parsed.error;
			return;
		}
		busy = true;
		try {
			const response = await fetch(`${base}/${encodeURIComponent(draftKey.trim())}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					valueType: draftType,
					defaultValue: parsed.value,
					description: draftDescription.trim() || null
				})
			});
			if (!response.ok) {
				const payload = (await response.json().catch(() => null)) as { error?: string } | null;
				draftError = payload?.error ?? 'could not save that parameter';
				return;
			}
			editorOpen = false;
			notice = '';
			await load();
		} finally {
			busy = false;
		}
	}

	async function remove(key: string) {
		busy = true;
		error = '';
		notice = '';
		try {
			await send(`${base}/${encodeURIComponent(key)}`, { method: 'DELETE' });
			await load();
		} finally {
			busy = false;
		}
	}

	async function publish() {
		busy = true;
		error = '';
		notice = '';
		try {
			const result = await send(`${base}/publish`, {
				method: 'POST',
				body: JSON.stringify({ reason: 'publish' })
			});
			if (result) {
				notice =
					result.versionCaptured === false
						? 'Published. No version was captured - point-in-time recovery is unavailable here.'
						: 'Published. Clients now get these values.';
			}
			await load();
		} finally {
			busy = false;
		}
	}

	async function discard() {
		busy = true;
		error = '';
		notice = '';
		confirmDiscard = false;
		try {
			await send(`${base}/discard`, { method: 'POST' });
			notice = 'Draft changes discarded.';
			await load();
		} finally {
			busy = false;
		}
	}

	async function rollback(point: DbRestorePoint) {
		busy = true;
		error = '';
		notice = '';
		rollbackTarget = null;
		try {
			const result = await send(`${base}/restore`, {
				method: 'POST',
				body: JSON.stringify({ bookmark: point.bookmark })
			});
			if (result) notice = `Rolled back to ${new Date(point.capturedAt).toLocaleString()}.`;
			await load();
		} finally {
			busy = false;
		}
	}

	/** What clients are being served right now, as text. */
	function shown(parameter: DbRemoteConfigParameter, which: 'draftValue' | 'publishedValue') {
		const value = parameter[which];
		if (parameter.state === 'draft' && which === 'publishedValue') return '—';
		if (parameter.valueType === 'string') return String(value ?? '');
		return JSON.stringify(value ?? null);
	}
</script>

<svelte:head>
	<title>{data.projectId} · Remote Config · Cloudflarebase</title>
	<!-- No project id: the console is noindex, so the only consumer of this is a
	     link unfurler, and that card must not name a project. -->
	<meta
		name="description"
		content="Feature flags and tuning values your app reads at startup, changed without a redeploy."
	/>
</svelte:head>

<div class="mx-auto max-w-6xl space-y-6 px-3 py-5 sm:space-y-8 sm:px-6 sm:py-8">
	<div class="flex flex-wrap items-start justify-between gap-4">
		<div>
			<h1 class="text-2xl font-semibold">Remote Config</h1>
			<p class="mt-1 max-w-2xl text-sm text-muted-foreground">
				Values your app reads at startup - feature flags, kill switches, limits - changed from here
				without shipping a release. Edits are a draft until you publish.
			</p>
		</div>
		<div class="flex shrink-0 items-center gap-2">
			<Button
				variant="outline"
				size="sm"
				disabled={busy || loading || pendingChanges === 0}
				onclick={() => (confirmDiscard = true)}
				data-testid="config-discard"
			>
				<Undo2 class="mr-1.5 h-3.5 w-3.5" /> Discard
			</Button>
			<Button
				size="sm"
				disabled={busy || loading || pendingChanges === 0}
				onclick={publish}
				data-testid="config-publish"
			>
				{#if busy}
					<LoaderCircle class="mr-1.5 h-3.5 w-3.5 animate-spin" />
				{:else}
					<Upload class="mr-1.5 h-3.5 w-3.5" />
				{/if}
				Publish changes
			</Button>
		</div>
	</div>

	{#if pendingChanges > 0}
		<div
			class="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
			data-testid="config-pending-banner"
		>
			<span class="font-medium">
				{pendingChanges}
				{pendingChanges === 1 ? 'change' : 'changes'} not published yet.
			</span>
			<span class="text-muted-foreground">
				Clients still get the last published values until you publish.
			</span>
		</div>
	{/if}

	{#if error}
		<p class="text-sm text-destructive" data-testid="config-error">{error}</p>
	{/if}
	{#if notice}
		<p class="text-sm text-muted-foreground" data-testid="config-notice">{notice}</p>
	{/if}

	<Card.Root>
		<Card.Header class="flex flex-row items-start justify-between gap-4 space-y-0">
			<div class="space-y-1.5">
				<Card.Title class="flex items-center gap-2">
					<SlidersHorizontal class="h-4 w-4 text-primary" /> Parameters
				</Card.Title>
				<Card.Description>
					{#if loading}
						Loading…
					{:else}
						{parameters.length} of {limit}. The key is what your app asks for.
					{/if}
				</Card.Description>
			</div>
			<Button
				size="sm"
				disabled={busy || loading || parameters.length >= limit}
				onclick={openNew}
				data-testid="config-new"
			>
				<Plus class="mr-1.5 h-3.5 w-3.5" /> Add parameter
			</Button>
		</Card.Header>
		<Card.Content>
			{#if loading}
				<div class="flex items-center gap-2 py-8 text-sm text-muted-foreground">
					<LoaderCircle class="h-4 w-4 animate-spin" /> Loading parameters…
				</div>
			{:else if parameters.length === 0}
				<div
					class="rounded-lg border border-dashed px-4 py-12 text-center"
					data-testid="config-empty"
				>
					<SlidersHorizontal class="mx-auto h-6 w-6 text-muted-foreground" />
					<p class="mt-3 text-sm font-medium">No parameters yet</p>
					<p class="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
						Add a flag like <code class="font-mono">checkoutV2</code>, read it in your app, and flip
						it from here without shipping anything.
					</p>
					<Button size="sm" class="mt-4" onclick={openNew} data-testid="config-new-empty">
						<Plus class="mr-1.5 h-3.5 w-3.5" /> Add your first parameter
					</Button>
				</div>
			{:else}
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head>Parameter</Table.Head>
							<Table.Head>Type</Table.Head>
							<Table.Head>Draft value</Table.Head>
							<Table.Head class="hidden md:table-cell">Serving now</Table.Head>
							<Table.Head class="w-24 text-right">Actions</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each parameters as parameter (parameter.key)}
							<Table.Row
								data-testid={`config-row-${parameter.key}`}
								class={parameter.state === 'deleting' ? 'opacity-60' : ''}
							>
								<Table.Cell>
									<div class="flex flex-wrap items-center gap-2">
										<span class="font-mono font-medium">{parameter.key}</span>
										{#if parameter.state === 'deleting'}
											<Badge variant="destructive" class="text-[10px]">removing on publish</Badge>
										{:else if parameter.state === 'draft'}
											<Badge variant="secondary" class="text-[10px]">new</Badge>
										{:else if parameter.pending}
											<Badge variant="secondary" class="text-[10px]">edited</Badge>
										{/if}
									</div>
									{#if parameter.description}
										<p class="mt-0.5 max-w-md truncate text-xs text-muted-foreground">
											{parameter.description}
										</p>
									{/if}
								</Table.Cell>
								<Table.Cell class="font-mono text-xs text-muted-foreground">
									{parameter.valueType}
								</Table.Cell>
								<Table.Cell class="max-w-56 truncate font-mono text-xs">
									{shown(parameter, 'draftValue')}
								</Table.Cell>
								<Table.Cell
									class="hidden max-w-56 truncate font-mono text-xs text-muted-foreground md:table-cell"
								>
									{shown(parameter, 'publishedValue')}
								</Table.Cell>
								<Table.Cell class="text-right whitespace-nowrap">
									<Button
										variant="ghost"
										size="icon"
										disabled={busy}
										aria-label={`Edit ${parameter.key}`}
										data-testid={`config-edit-${parameter.key}`}
										onclick={() => openEdit(parameter)}
									>
										<Pencil class="h-3.5 w-3.5" />
									</Button>
									<Button
										variant="ghost"
										size="icon"
										disabled={busy}
										aria-label={`Remove ${parameter.key}`}
										data-testid={`config-delete-${parameter.key}`}
										onclick={() => remove(parameter.key)}
									>
										<Trash2 class="h-3.5 w-3.5 text-destructive" />
									</Button>
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header class="space-y-1.5">
			<Card.Title class="flex items-center gap-2">
				<History class="h-4 w-4 text-muted-foreground" /> Change history
			</Card.Title>
			<Card.Description>
				Every publish captures a restore point. Rolling back puts the parameters exactly as they
				were - and itself becomes a point you can undo.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if !versionsSupported}
				<p class="text-sm text-muted-foreground" data-testid="config-versions-unsupported">
					Point-in-time recovery is not available in this environment, so publishing records no
					version here. It works on a deployed project.
				</p>
			{:else if versions.length === 0}
				<p class="text-sm text-muted-foreground" data-testid="config-versions-empty">
					{everPublished
						? 'No versions recorded yet.'
						: 'Nothing published yet - your first publish starts the history.'}
				</p>
			{:else}
				<ul class="divide-y" data-testid="config-versions">
					{#each versions as point (point.bookmark)}
						<li class="flex items-center justify-between gap-4 py-2.5">
							<div class="min-w-0">
								<p class="text-sm font-medium">{new Date(point.capturedAt).toLocaleString()}</p>
								<p class="truncate text-xs text-muted-foreground">{point.reason}</p>
							</div>
							<Button
								variant="outline"
								size="sm"
								disabled={busy}
								onclick={() => (rollbackTarget = point)}
								data-testid={`config-rollback-${point.bookmark}`}
							>
								<RotateCcw class="mr-1.5 h-3.5 w-3.5" /> Roll back
							</Button>
						</li>
					{/each}
				</ul>
			{/if}
		</Card.Content>
	</Card.Root>
</div>

<Dialog.Root bind:open={editorOpen}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{editingKey ? `Edit ${editingKey}` : 'Add parameter'}</Dialog.Title>
			<Dialog.Description>
				Saving stores a draft. Nothing reaches your app until you publish.
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-4">
			<div class="space-y-1.5">
				<Label for="config-key">Parameter key</Label>
				<Input
					id="config-key"
					bind:value={draftKey}
					disabled={Boolean(editingKey)}
					placeholder="checkoutV2"
					class="font-mono"
					data-testid="config-key"
				/>
				{#if editingKey}
					<p class="text-xs text-muted-foreground">
						The key is how your app addresses this value, so it cannot be renamed - add a new one
						and remove this.
					</p>
				{/if}
			</div>

			<div class="space-y-1.5">
				<Label>Type</Label>
				<Select.Root
					type="single"
					value={draftType}
					onValueChange={(value) => {
						draftType = (VALUE_TYPES as readonly string[]).includes(value)
							? (value as ValueType)
							: 'string';
						// Reset to something valid for the new type - the dialog should
						// never open onto an error the operator did not cause.
						draftValue = draftType === 'boolean' ? 'false' : draftType === 'number' ? '0' : '';
					}}
				>
					<Select.Trigger class="w-full font-mono" data-testid="config-type">
						{draftType}
					</Select.Trigger>
					<Select.Content>
						{#each VALUE_TYPES as type (type)}
							<Select.Item value={type} label={type} class="font-mono" />
						{/each}
					</Select.Content>
				</Select.Root>
			</div>

			<div class="space-y-1.5">
				<Label for="config-value">Value</Label>
				{#if draftType === 'json'}
					<Textarea
						id="config-value"
						bind:value={draftValue}
						rows={4}
						placeholder={'{"variant": "b"}'}
						class="font-mono text-xs"
						data-testid="config-value"
					/>
				{:else}
					<Input
						id="config-value"
						bind:value={draftValue}
						placeholder={draftType === 'boolean' ? 'true' : draftType === 'number' ? '25' : 'eur'}
						class="font-mono"
						data-testid="config-value"
					/>
				{/if}
				<p class="text-xs text-muted-foreground">
					{#if draftType === 'string'}
						Typed as-is - no quoting.
					{:else if draftType === 'boolean'}
						<code class="font-mono">true</code> or <code class="font-mono">false</code>.
					{:else if draftType === 'number'}
						A finite number, e.g. <code class="font-mono">25</code>.
					{:else}
						Any JSON value - an object, an array, or <code class="font-mono">null</code>.
					{/if}
				</p>
			</div>

			<div class="space-y-1.5">
				<Label for="config-description">
					Description <span class="font-normal text-muted-foreground">(optional)</span>
				</Label>
				<Input
					id="config-description"
					bind:value={draftDescription}
					placeholder="What flipping this does"
					data-testid="config-description"
				/>
				<p class="text-xs text-muted-foreground">
					For whoever reads this page next. Never sent to clients.
				</p>
			</div>

			{#if draftError}
				<p class="text-sm text-destructive" data-testid="config-draft-error">{draftError}</p>
			{/if}
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (editorOpen = false)} disabled={busy}>Cancel</Button>
			<Button onclick={save} disabled={busy || !draftKey.trim()} data-testid="config-save">
				{#if busy}<LoaderCircle class="mr-1.5 h-3.5 w-3.5 animate-spin" />{/if}
				Save draft
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<AlertDialog.Root bind:open={confirmDiscard}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Discard draft changes?</AlertDialog.Title>
			<AlertDialog.Description>
				Every unpublished edit goes back to what your app is being served right now. Parameters you
				added but never published are removed. This cannot be undone.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Keep editing</AlertDialog.Cancel>
			<AlertDialog.Action onclick={discard} data-testid="config-discard-confirm">
				Discard
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<AlertDialog.Root
	open={rollbackTarget !== null}
	onOpenChange={(open) => {
		if (!open) rollbackTarget = null;
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Roll back to this version?</AlertDialog.Title>
			<AlertDialog.Description>
				Every parameter goes back to how it was at {rollbackTarget
					? new Date(rollbackTarget.capturedAt).toLocaleString()
					: ''}, drafts included. The rollback itself becomes a point you can undo.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				onclick={() => rollbackTarget && rollback(rollbackTarget)}
				data-testid="config-rollback-confirm"
			>
				Roll back
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
