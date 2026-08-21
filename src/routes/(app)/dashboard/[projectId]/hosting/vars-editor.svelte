<script module lang="ts">
	export interface VarsSavePayload {
		/** The FULL text-var set - absent names are deletions. */
		vars: Record<string, string>;
		/** Secrets to (re)write - new rows and re-entered stored ones. */
		setSecrets: { name: string; value: string }[];
		/** Stored secrets whose rows were removed. */
		deleteSecrets: string[];
	}
</script>

<script lang="ts">
	import type { HostingSecretMeta, HostingVar } from '$lib/agents';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import { Plus, Trash2 } from '@lucide/svelte';

	/**
	 * The CF-Workers-style variables-and-secrets editor: one table, a
	 * Text/Secret type per row, whole-table Save. Shared by the runtime and
	 * build sections - the parent owns the endpoints via `save`.
	 *
	 * Secrets are write-only: a stored secret renders with a "Value encrypted"
	 * placeholder, and leaving it blank keeps the current value (the auth
	 * settings convention). Removing its row deletes it on Save.
	 */

	interface Row {
		key: number;
		name: string;
		value: string;
		type: 'text' | 'secret';
		/** A stored secret rendered write-only; blank value = keep. */
		storedSecret: boolean;
	}

	let {
		idPrefix,
		vars,
		secrets,
		secretsEnabled = true,
		secretsDisabledReason = '',
		save
	}: {
		/** Testid namespace, e.g. `hosting-vars` / `hosting-build`. */
		idPrefix: string;
		vars: HostingVar[];
		secrets: HostingSecretMeta[];
		secretsEnabled?: boolean;
		secretsDisabledReason?: string;
		/** Applies the change set; returns an error message or null. */
		save: (payload: VarsSavePayload) => Promise<string | null>;
	} = $props();

	let nextKey = 0;
	let rows = $state<Row[]>([]);
	let seeded = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let notice = $state<string | null>(null);

	// Reseed pending state from server truth only when IT changes - typing
	// never fights a poll (the storage access-tool pattern).
	$effect(() => {
		const signature = JSON.stringify([
			vars.map((entry) => [entry.name, entry.value]),
			secrets.map((entry) => entry.name)
		]);
		if (signature === seeded) return;
		seeded = signature;
		rows = [
			...vars.map((entry) => ({
				key: nextKey++,
				name: entry.name,
				value: entry.value,
				type: 'text' as const,
				storedSecret: false
			})),
			...secrets.map((entry) => ({
				key: nextKey++,
				name: entry.name,
				value: '',
				type: 'secret' as const,
				storedSecret: true
			}))
		];
	});

	const NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

	const dirty = $derived.by(() => {
		const originalVars = new Map(vars.map((entry) => [entry.name, entry.value]));
		const originalSecrets = new Set(secrets.map((entry) => entry.name));
		const textRows = rows.filter((row) => row.type === 'text');
		if (textRows.length !== originalVars.size) return true;
		if (textRows.some((row) => originalVars.get(row.name) !== row.value)) return true;
		const secretRows = rows.filter((row) => row.type === 'secret');
		// A new secret, a re-entered value, or a removed stored secret.
		if (secretRows.some((row) => !row.storedSecret || row.value !== '')) return true;
		if ([...originalSecrets].some((name) => !secretRows.some((row) => row.name === name)))
			return true;
		return false;
	});

	const invalid = $derived.by(() => {
		const names = rows.map((row) => row.name.trim());
		if (names.some((name) => name && !NAME_PATTERN.test(name)))
			return 'Names are UPPER_SNAKE_CASE.';
		if (rows.some((row) => !row.name.trim() && (row.value || row.type === 'secret')))
			return 'Every row needs a name.';
		const filled = names.filter(Boolean);
		if (new Set(filled).size !== filled.length) return 'Names must be unique.';
		if (rows.some((row) => /[\r\n]/.test(row.value))) return 'Values are single-line.';
		if (rows.some((row) => row.type === 'secret' && !row.storedSecret && !row.value))
			return 'New secrets need a value.';
		return null;
	});

	function addRow() {
		rows = [...rows, { key: nextKey++, name: '', value: '', type: 'text', storedSecret: false }];
	}

	function removeRow(key: number) {
		rows = rows.filter((row) => row.key !== key);
	}

	async function submit() {
		if (busy || !dirty || invalid) return;
		busy = true;
		error = null;
		notice = null;
		try {
			const kept = rows.filter((row) => row.name.trim());
			const payload: VarsSavePayload = {
				vars: Object.fromEntries(
					kept.filter((row) => row.type === 'text').map((row) => [row.name.trim(), row.value])
				),
				setSecrets: kept
					.filter((row) => row.type === 'secret' && row.value !== '')
					.map((row) => ({ name: row.name.trim(), value: row.value })),
				deleteSecrets: secrets
					.map((entry) => entry.name)
					.filter((name) => !kept.some((row) => row.type === 'secret' && row.name.trim() === name))
			};
			const failure = await save(payload);
			if (failure) {
				error = failure;
				return;
			}
			notice = 'Saved.';
			setTimeout(() => (notice = null), 2500);
		} finally {
			busy = false;
		}
	}
</script>

<div class="space-y-3" data-testid={`${idPrefix}-editor`}>
	{#if rows.length === 0}
		<p class="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
			No variables yet. Text values upload as plain-text bindings; secrets are encrypted and never
			shown again.
		</p>
	{:else}
		<div class="grid gap-2">
			{#each rows as row, index (row.key)}
				<div class="flex flex-wrap items-center gap-2" data-testid={`${idPrefix}-row-${index}`}>
					<Select.Root
						type="single"
						value={row.type}
						onValueChange={(value) => {
							if (!value || row.storedSecret) return;
							row.type = value as 'text' | 'secret';
						}}
						disabled={row.storedSecret || (!secretsEnabled && row.type === 'text')}
					>
						<Select.Trigger
							size="sm"
							class="w-24 shrink-0"
							aria-label="Type"
							data-testid={`${idPrefix}-type-${index}`}
						>
							{row.type === 'secret' ? 'Secret' : 'Text'}
						</Select.Trigger>
						<Select.Content>
							<Select.Item value="text" label="Text" />
							<Select.Item value="secret" label="Secret" disabled={!secretsEnabled} />
						</Select.Content>
					</Select.Root>
					<Input
						class="w-44 shrink-0 font-mono text-xs"
						placeholder="NAME"
						bind:value={row.name}
						disabled={row.storedSecret}
						autocomplete="off"
						data-testid={`${idPrefix}-name-${index}`}
					/>
					<Input
						class="min-w-40 flex-1 font-mono text-xs"
						type={row.type === 'secret' ? 'password' : 'text'}
						placeholder={row.storedSecret ? 'Value encrypted - leave blank to keep' : 'value'}
						bind:value={row.value}
						autocomplete="off"
						data-testid={`${idPrefix}-value-${index}`}
					/>
					<Button
						variant="ghost"
						size="icon"
						class="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
						aria-label={`Remove ${row.name || 'row'}`}
						data-testid={`${idPrefix}-remove-${index}`}
						onclick={() => removeRow(row.key)}
					>
						<Trash2 class="h-4 w-4" />
					</Button>
				</div>
			{/each}
		</div>
	{/if}

	{#if !secretsEnabled && secretsDisabledReason}
		<p class="text-xs text-muted-foreground">{secretsDisabledReason}</p>
	{/if}

	<div class="flex flex-wrap items-center gap-2">
		<Button
			size="sm"
			variant="outline"
			class="gap-1.5"
			onclick={addRow}
			data-testid={`${idPrefix}-add`}
		>
			<Plus class="h-3.5 w-3.5" /> Add variable
		</Button>
		<Button
			size="sm"
			disabled={busy || !dirty || !!invalid}
			onclick={submit}
			data-testid={`${idPrefix}-save`}
		>
			{busy ? 'Saving…' : 'Save'}
		</Button>
		{#if invalid && dirty}
			<span class="text-xs text-muted-foreground">{invalid}</span>
		{/if}
		{#if error}
			<span class="text-sm text-destructive" data-testid={`${idPrefix}-error`}>{error}</span>
		{/if}
		{#if notice}
			<span class="text-sm text-muted-foreground" data-testid={`${idPrefix}-feedback`}
				>{notice}</span
			>
		{/if}
	</div>
</div>
