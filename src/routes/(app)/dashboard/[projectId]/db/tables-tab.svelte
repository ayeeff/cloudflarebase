<script lang="ts">
	import type {
		DbColumnType,
		DbDocument,
		DbQueryResult,
		DbReplicationMode,
		DbTableColumn,
		DbTableSummary
	} from '$lib/agents';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Select from '$lib/components/ui/select';
	import * as Table from '$lib/components/ui/table';
	import { Textarea } from '$lib/components/ui/textarea';
	import { ulid } from '$lib/ulid';
	import { Columns3, Pencil, Plus, Table2, Trash2, X } from '@lucide/svelte';

	/**
	 * The Tables tab: schema-first SQL tables beside the document collections.
	 * Declaring, altering, and access modes are ONE form on purpose - the
	 * admin API takes the full desired schema plus modes in a single PUT, so
	 * the UI mirrors the contract instead of splitting it across tabs.
	 */

	let {
		projectId,
		tables,
		totalRows,
		permissionOptions,
		refresh
	}: {
		projectId: string;
		tables: DbTableSummary[];
		totalRows: number;
		permissionOptions: (current: string) => string[];
		refresh: () => Promise<void>;
	} = $props();

	const NO_PERMISSION = '__none__';
	const accessModes = ['public', 'auth', 'owner'] as const;
	const columnTypes: DbColumnType[] = ['text', 'integer', 'real', 'boolean', 'json'];

	const adminBase = $derived(`/api/projects/${projectId}/db/admin`);

	// -------------------------------------------------------------------------
	// Schema designer (declare + alter share it - one PUT either way)

	type ColumnDraft = {
		name: string;
		type: DbColumnType;
		nullable: boolean;
		unique: boolean;
		index: boolean;
		/** Typed loosely as text; parsed per column type on submit ('' = none). */
		defaultText: string;
		/** Bounds/enum the form does not edit ride along so an alter cannot
		 * silently wipe them (the PUT takes the FULL desired schema). */
		extras: Pick<DbTableColumn, 'maxLength' | 'min' | 'max' | 'enum'>;
	};

	function blankColumn(): ColumnDraft {
		return {
			name: '',
			type: 'text',
			nullable: true,
			unique: false,
			index: false,
			defaultText: '',
			extras: {}
		};
	}

	function toDraft(column: DbTableColumn): ColumnDraft {
		return {
			name: column.name,
			type: column.type,
			nullable: column.nullable !== false,
			unique: column.unique === true,
			index: column.index === true,
			defaultText:
				column.default === undefined || column.default === null ? '' : String(column.default),
			extras: {
				...(column.maxLength !== undefined ? { maxLength: column.maxLength } : {}),
				...(column.min !== undefined ? { min: column.min } : {}),
				...(column.max !== undefined ? { max: column.max } : {}),
				...(column.enum !== undefined ? { enum: column.enum } : {})
			}
		};
	}

	function fromDraft(draft: ColumnDraft): DbTableColumn | string {
		const name = draft.name.trim().toLowerCase();
		if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) {
			return `"${draft.name}" - column names are lowercase letters, digits, and _ (max 64 chars)`;
		}
		let parsedDefault: DbTableColumn['default'];
		const text = draft.defaultText.trim();
		if (text !== '') {
			if (draft.type === 'text') parsedDefault = draft.defaultText;
			else if (draft.type === 'boolean') {
				if (text !== 'true' && text !== 'false')
					return `"${name}" - boolean defaults are true or false`;
				parsedDefault = text === 'true';
			} else if (draft.type === 'integer' || draft.type === 'real') {
				const numeric = Number(text);
				if (!Number.isFinite(numeric)) return `"${name}" - the default must be a number`;
				if (draft.type === 'integer' && !Number.isInteger(numeric)) {
					return `"${name}" - the default must be an integer`;
				}
				parsedDefault = numeric;
			} else {
				return `"${name}" - json columns cannot declare a default`;
			}
		}
		return {
			name,
			type: draft.type,
			nullable: draft.nullable,
			unique: draft.unique,
			index: draft.index,
			...(parsedDefault !== undefined ? { default: parsedDefault } : {}),
			...draft.extras
		};
	}

	let designerFor = $state<string | null>(null); // null = declaring a new table
	let designerName = $state('');
	let designerColumns = $state<ColumnDraft[]>([blankColumn()]);
	let designerRead = $state<string>('public');
	let designerWrite = $state<string>('owner');
	let designerReadPermission = $state('');
	let designerWritePermission = $state('');
	let designerReplication = $state<DbReplicationMode>('auto');
	let designerError = $state<string | null>(null);
	let designerBusy = $state(false);

	function resetDesigner() {
		designerFor = null;
		designerName = '';
		designerColumns = [blankColumn()];
		designerRead = 'public';
		designerWrite = 'owner';
		designerReadPermission = '';
		designerWritePermission = '';
		designerReplication = 'auto';
		designerError = null;
	}

	function openAlter(table: DbTableSummary) {
		designerFor = table.name;
		designerName = table.name;
		designerColumns = table.columns.map(toDraft);
		designerRead = table.readAccess;
		designerWrite = table.writeAccess;
		designerReadPermission = table.readPermission ?? '';
		designerWritePermission = table.writePermission ?? '';
		designerReplication = table.replication;
		designerError = null;
	}

	/** Live plain-English restatement of the pending access configuration. */
	const designerSentence = $derived.by(() => {
		const withKey = (key: string) => (key.trim() ? ` whose role grants ${key.trim()}` : '');
		const read =
			designerRead === 'public'
				? 'anyone can read every row'
				: designerRead === 'auth'
					? `any signed-in user${withKey(designerReadPermission)} can read every row`
					: `signed-in users${withKey(designerReadPermission)} can read only rows they created`;
		const write =
			designerWrite === 'public'
				? 'anyone can insert, edit, and delete rows'
				: designerWrite === 'auth'
					? `any signed-in user${withKey(designerWritePermission)} can insert, edit, and delete any row`
					: `signed-in users${withKey(designerWritePermission)} can insert rows but edit or delete only their own`;
		const replication =
			designerReplication === 'auto'
				? 'Reads are served from a replica in the reader’s region.'
				: 'Replication is off - every read travels to the primary.';
		return `Read: ${read}. Write: ${write}. Every write must match the declared columns. ${replication}`;
	});

	async function submitDesigner(event: SubmitEvent) {
		event.preventDefault();
		designerError = null;
		const name = (designerFor ?? designerName).trim().toLowerCase();
		if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) {
			designerError = 'Table names are lowercase letters, digits, _ and - (max 64 chars).';
			return;
		}
		if (!designerFor && tables.some((table) => table.name === name)) {
			designerError = `Table "${name}" already exists - use "Edit schema" on its row instead.`;
			return;
		}
		const columns: DbTableColumn[] = [];
		for (const draft of designerColumns) {
			const parsed = fromDraft(draft);
			if (typeof parsed === 'string') {
				designerError = parsed;
				return;
			}
			columns.push(parsed);
		}
		if (columns.length === 0) {
			designerError = 'Declare at least one column.';
			return;
		}
		designerBusy = true;
		try {
			const response = await fetch(`${adminBase}/tables/${encodeURIComponent(name)}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					readAccess: designerRead,
					writeAccess: designerWrite,
					readPermission: designerReadPermission.trim() || null,
					writePermission: designerWritePermission.trim() || null,
					replication: designerReplication,
					columns
				})
			});
			if (!response.ok) {
				const result = (await response.json().catch(() => null)) as { error?: string } | null;
				throw new Error(result?.error ?? `request failed (HTTP ${response.status})`);
			}
			await refresh();
			if (selected === name) await loadRows(name);
			resetDesigner();
		} catch (error) {
			designerError = error instanceof Error ? error.message : String(error);
		} finally {
			designerBusy = false;
		}
	}

	// -------------------------------------------------------------------------
	// Row browser

	let selected = $state<string | null>(null);
	let rows = $state<DbDocument[]>([]);
	let rowsLoaded = $state(false);
	let rowsError = $state<string | null>(null);

	const selectedTable = $derived(tables.find((table) => table.name === selected) ?? null);

	function selectTable(name: string) {
		if (selected === name) {
			selected = null;
			rows = [];
			rowsLoaded = false;
			rowsError = null;
			return;
		}
		selected = name;
		rows = [];
		rowsLoaded = false;
		rowsError = null;
		void loadRows(name);
	}

	async function loadRows(table: string) {
		try {
			const response = await fetch(`${adminBase}/query`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ table, query: { limit: 50 } })
			});
			if (selected !== table) return;
			const result = (await response.json().catch(() => null)) as
				(DbQueryResult & { error?: string }) | null;
			if (!response.ok || !result) {
				throw new Error(result?.error ?? `request failed (HTTP ${response.status})`);
			}
			rows = result.docs;
			rowsError = null;
		} catch (error) {
			if (selected !== table) return;
			rowsError = error instanceof Error ? error.message : String(error);
		} finally {
			if (selected === table) rowsLoaded = true;
		}
	}

	function cellText(value: unknown): string {
		if (value === null || value === undefined) return '—';
		if (typeof value === 'boolean') return value ? 'true' : 'false';
		if (typeof value === 'object') {
			const json = JSON.stringify(value);
			return json.length > 40 ? `${json.slice(0, 40)}…` : json;
		}
		return String(value);
	}

	// -------------------------------------------------------------------------
	// Row editor: JSON of the column map, prefilled from defaults or the row.
	// The typed grid is the read view; the agent validates the write against
	// the declared schema and returns precise issues.

	let editorOpen = $state(false);
	let editorRowId = $state<string | null>(null); // null = inserting
	let editorJson = $state('');
	let editorError = $state<string | null>(null);
	let editorBusy = $state(false);

	function openInsert() {
		const template: Record<string, unknown> = {};
		for (const column of selectedTable?.columns ?? []) {
			template[column.name] = column.default ?? null;
		}
		editorRowId = null;
		editorJson = JSON.stringify(template, null, 2);
		editorError = null;
		editorOpen = true;
	}

	function openEdit(row: DbDocument) {
		editorRowId = row.id;
		editorJson = JSON.stringify(row.data, null, 2);
		editorError = null;
		editorOpen = true;
	}

	async function saveRow() {
		const table = selected;
		if (!table) return;
		let data: unknown;
		try {
			data = JSON.parse(editorJson);
		} catch (error) {
			editorError = `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
			return;
		}
		if (typeof data !== 'object' || data === null || Array.isArray(data)) {
			editorError = 'The row must be a JSON object of column values.';
			return;
		}
		editorBusy = true;
		editorError = null;
		try {
			const id = editorRowId ?? ulid();
			const suffix = editorRowId ? '' : '?ifAbsent=1';
			const response = await fetch(
				`${adminBase}/tables/${encodeURIComponent(table)}/rows/${encodeURIComponent(id)}${suffix}`,
				{
					method: 'PUT',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ data })
				}
			);
			const result = (await response.json().catch(() => null)) as {
				error?: string;
				issues?: string[];
			} | null;
			if (!response.ok) {
				throw new Error(
					[
						result?.error ?? `request failed (HTTP ${response.status})`,
						...(result?.issues ?? [])
					].join(' · ')
				);
			}
			editorOpen = false;
			await loadRows(table);
			await refresh();
		} catch (error) {
			editorError = error instanceof Error ? error.message : String(error);
		} finally {
			editorBusy = false;
		}
	}

	async function deleteRow(id: string) {
		const table = selected;
		if (!table) return;
		try {
			const response = await fetch(
				`${adminBase}/tables/${encodeURIComponent(table)}/rows/${encodeURIComponent(id)}`,
				{ method: 'DELETE' }
			);
			if (!response.ok) {
				const result = (await response.json().catch(() => null)) as { error?: string } | null;
				throw new Error(result?.error ?? `request failed (HTTP ${response.status})`);
			}
			await loadRows(table);
			await refresh();
		} catch (error) {
			rowsError = error instanceof Error ? error.message : String(error);
		}
	}

	// -------------------------------------------------------------------------
	// Delete table (typed-name confirmation, like the collections panel)

	let deleteOpen = $state(false);
	let deleteConfirm = $state('');
	let deleteError = $state<string | null>(null);
	let deleteBusy = $state(false);

	async function deleteTable() {
		const table = selected;
		if (!table || deleteConfirm !== table) return;
		deleteBusy = true;
		deleteError = null;
		try {
			const response = await fetch(`${adminBase}/tables/${encodeURIComponent(table)}`, {
				method: 'DELETE'
			});
			if (!response.ok) {
				const result = (await response.json().catch(() => null)) as { error?: string } | null;
				throw new Error(result?.error ?? `request failed (HTTP ${response.status})`);
			}
			deleteOpen = false;
			deleteConfirm = '';
			selected = null;
			rows = [];
			rowsLoaded = false;
			await refresh();
		} catch (error) {
			deleteError = error instanceof Error ? error.message : String(error);
		} finally {
			deleteBusy = false;
		}
	}
</script>

<div class="mt-4 space-y-5 sm:space-y-6">
	<div class="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
		{#each [{ id: 'tables', label: 'Tables', value: tables.length, icon: Table2 }, { id: 'rows', label: 'Rows', value: totalRows, icon: Columns3 }, { id: 'columns', label: 'Declared columns', value: tables.reduce((sum, table) => sum + table.columns.length, 0), icon: Columns3 }] as stat (stat.id)}
			<Card.Root class="py-4" data-testid={`db-tables-stat-${stat.id}`}>
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
		<Card.Root class="min-w-0 lg:col-span-2" data-testid="db-tables-card">
			<Card.Header>
				<Card.Title>Tables</Card.Title>
				<Card.Description>
					Schema-first SQL: declare typed columns, then click a table to browse its rows.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				{#if tables.length === 0}
					<p class="py-8 text-center text-sm text-muted-foreground" data-testid="db-tables-empty">
						No tables yet - declare one to get typed columns, unique indexes, and live queries over
						SQL rows.
					</p>
				{:else}
					<div class="overflow-x-auto">
						<Table.Root class="min-w-[36rem]" data-testid="db-tables-table">
							<Table.Header>
								<Table.Row>
									<Table.Head>Name</Table.Head>
									<Table.Head>Columns</Table.Head>
									<Table.Head class="text-right">Rows</Table.Head>
									<Table.Head>Read</Table.Head>
									<Table.Head>Write</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each tables as table (table.name)}
									<Table.Row
										class={['cursor-pointer', selected === table.name && 'bg-muted/50']}
										data-testid={`db-table-${table.name}`}
										onclick={() => selectTable(table.name)}
									>
										<Table.Cell class="font-mono font-medium">{table.name}</Table.Cell>
										<Table.Cell class="max-w-[16rem]">
											<span class="block truncate font-mono text-xs text-muted-foreground">
												{table.columns.map((column) => `${column.name}:${column.type}`).join(', ')}
											</span>
										</Table.Cell>
										<Table.Cell class="text-right tabular-nums">{table.rows}</Table.Cell>
										<Table.Cell><Badge variant="outline">{table.readAccess}</Badge></Table.Cell>
										<Table.Cell><Badge variant="outline">{table.writeAccess}</Badge></Table.Cell>
									</Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					</div>
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root data-testid="db-declare-table">
			<Card.Header>
				<Card.Title>{designerFor ? `Alter "${designerFor}"` : 'Declare a table'}</Card.Title>
				<Card.Description>
					{designerFor
						? 'Add columns or toggle indexes. Destructive changes are refused - export and recreate instead.'
						: 'The full schema up front: typed columns, defaults, unique and secondary indexes.'}
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<form class="space-y-3" onsubmit={submitDesigner}>
					{#if !designerFor}
						<div class="space-y-1.5">
							<Label for="new-table-name">Name</Label>
							<Input
								id="new-table-name"
								bind:value={designerName}
								placeholder="todos"
								autocomplete="off"
								data-testid="db-new-table-name"
							/>
						</div>
					{/if}

					<div class="space-y-2">
						<Label>Columns</Label>
						{#each designerColumns as column, index (index)}
							<div class="space-y-1.5 rounded-md border p-2" data-testid={`db-column-${index}`}>
								<div class="flex items-center gap-1.5">
									<Input
										class="h-8 font-mono text-xs"
										placeholder="column_name"
										autocomplete="off"
										bind:value={column.name}
										data-testid={`db-column-name-${index}`}
									/>
									<Select.Root
										type="single"
										value={column.type}
										onValueChange={(value) => {
											if (value) column.type = value as DbColumnType;
										}}
									>
										<Select.Trigger
											class="h-8 w-24 text-xs"
											data-testid={`db-column-type-${index}`}
										>
											{column.type}
										</Select.Trigger>
										<Select.Content>
											{#each columnTypes as type (type)}
												<Select.Item value={type}>{type}</Select.Item>
											{/each}
										</Select.Content>
									</Select.Root>
									<Button
										type="button"
										variant="ghost"
										size="icon"
										class="h-8 w-8 shrink-0"
										aria-label="Remove column"
										onclick={() => {
											designerColumns = designerColumns.filter((_, i) => i !== index);
										}}
									>
										<X class="h-3.5 w-3.5" />
									</Button>
								</div>
								<div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
									<label class="flex items-center gap-1">
										<input type="checkbox" bind:checked={column.nullable} /> nullable
									</label>
									<label class="flex items-center gap-1">
										<input type="checkbox" bind:checked={column.unique} /> unique
									</label>
									<label class="flex items-center gap-1">
										<input type="checkbox" bind:checked={column.index} /> index
									</label>
									{#if column.type !== 'json'}
										<Input
											class="h-7 w-24 text-xs"
											placeholder="default"
											autocomplete="off"
											bind:value={column.defaultText}
										/>
									{/if}
								</div>
							</div>
						{/each}
						<Button
							type="button"
							variant="outline"
							size="sm"
							class="w-full"
							data-testid="db-add-column"
							onclick={() => (designerColumns = [...designerColumns, blankColumn()])}
						>
							<Plus class="h-3.5 w-3.5" /> Add column
						</Button>
					</div>

					<div class="grid grid-cols-2 gap-2">
						<div class="space-y-1.5">
							<Label>Read</Label>
							<Select.Root type="single" bind:value={designerRead}>
								<Select.Trigger class="w-full" data-testid="db-new-table-read">
									{designerRead}
								</Select.Trigger>
								<Select.Content>
									{#each accessModes as mode (mode)}
										<Select.Item value={mode}>{mode}</Select.Item>
									{/each}
								</Select.Content>
							</Select.Root>
						</div>
						<div class="space-y-1.5">
							<Label>Write</Label>
							<Select.Root type="single" bind:value={designerWrite}>
								<Select.Trigger class="w-full" data-testid="db-new-table-write">
									{designerWrite}
								</Select.Trigger>
								<Select.Content>
									{#each accessModes as mode (mode)}
										<Select.Item value={mode}>{mode}</Select.Item>
									{/each}
								</Select.Content>
							</Select.Root>
						</div>
					</div>

					<div class="space-y-1.5">
						<Label>Replication</Label>
						<Select.Root
							type="single"
							value={designerReplication}
							onValueChange={(value) => {
								designerReplication = value === 'off' ? 'off' : 'auto';
							}}
						>
							<Select.Trigger class="w-full" data-testid="db-new-table-replication">
								{designerReplication === 'auto'
									? 'auto (per-region replicas)'
									: 'off (single region)'}
							</Select.Trigger>
							<Select.Content>
								<Select.Item value="auto">auto (per-region replicas)</Select.Item>
								<Select.Item value="off">off (single region)</Select.Item>
							</Select.Content>
						</Select.Root>
					</div>

					{#if designerRead !== 'public' || designerWrite !== 'public'}
						<div class="grid grid-cols-2 gap-2">
							{#if designerRead !== 'public'}
								<div class="space-y-1.5">
									<Label class="text-xs">Read permission</Label>
									<Select.Root
										type="single"
										value={designerReadPermission || NO_PERMISSION}
										onValueChange={(value) => {
											designerReadPermission = value === NO_PERMISSION ? '' : (value ?? '');
										}}
									>
										<Select.Trigger class="w-full text-xs">
											{designerReadPermission || 'none'}
										</Select.Trigger>
										<Select.Content>
											<Select.Item value={NO_PERMISSION}>none</Select.Item>
											{#each permissionOptions(designerReadPermission) as key (key)}
												<Select.Item value={key}>{key}</Select.Item>
											{/each}
										</Select.Content>
									</Select.Root>
								</div>
							{/if}
							{#if designerWrite !== 'public'}
								<div class="space-y-1.5">
									<Label class="text-xs">Write permission</Label>
									<Select.Root
										type="single"
										value={designerWritePermission || NO_PERMISSION}
										onValueChange={(value) => {
											designerWritePermission = value === NO_PERMISSION ? '' : (value ?? '');
										}}
									>
										<Select.Trigger class="w-full text-xs">
											{designerWritePermission || 'none'}
										</Select.Trigger>
										<Select.Content>
											<Select.Item value={NO_PERMISSION}>none</Select.Item>
											{#each permissionOptions(designerWritePermission) as key (key)}
												<Select.Item value={key}>{key}</Select.Item>
											{/each}
										</Select.Content>
									</Select.Root>
								</div>
							{/if}
						</div>
					{/if}

					<p class="text-xs text-muted-foreground" data-testid="db-table-access-sentence">
						{designerSentence}
					</p>

					<div class="flex items-center gap-2">
						<Button type="submit" disabled={designerBusy} data-testid="db-declare-submit">
							<Plus class="h-4 w-4" />
							{designerFor ? 'Apply changes' : 'Declare'}
						</Button>
						{#if designerFor}
							<Button type="button" variant="ghost" onclick={resetDesigner}>Cancel</Button>
						{/if}
					</div>
					{#if designerError}
						<p class="text-sm text-destructive" data-testid="db-declare-error">{designerError}</p>
					{/if}
				</form>
			</Card.Content>
		</Card.Root>
	</div>

	{#if selected && selectedTable}
		<Card.Root data-testid="db-rows-card">
			<Card.Header class="flex flex-row flex-wrap items-center justify-between gap-2">
				<div>
					<Card.Title class="font-mono">{selected}</Card.Title>
					<Card.Description>
						{selectedTable.columns.length} declared columns · newest last (ids are chronological)
					</Card.Description>
				</div>
				<div class="flex items-center gap-2">
					<Button size="sm" onclick={openInsert} data-testid="db-add-row">
						<Plus class="h-3.5 w-3.5" /> Add row
					</Button>
					<Button size="sm" variant="outline" onclick={() => openAlter(selectedTable)}>
						<Pencil class="h-3.5 w-3.5" /> Edit schema
					</Button>
					<Button
						size="sm"
						variant="outline"
						class="text-destructive"
						data-testid="db-delete-table"
						onclick={() => {
							deleteConfirm = '';
							deleteError = null;
							deleteOpen = true;
						}}
					>
						<Trash2 class="h-3.5 w-3.5" /> Delete
					</Button>
				</div>
			</Card.Header>
			<Card.Content>
				{#if rowsError}
					<p class="mb-3 text-sm text-destructive" data-testid="db-rows-error">{rowsError}</p>
				{/if}
				{#if !rowsLoaded}
					<p class="py-6 text-center text-sm text-muted-foreground">Loading rows…</p>
				{:else if rows.length === 0}
					<p class="py-6 text-center text-sm text-muted-foreground" data-testid="db-rows-empty">
						No rows yet.
					</p>
				{:else}
					<div class="overflow-x-auto">
						<Table.Root class="min-w-[42rem]" data-testid="db-rows-table">
							<Table.Header>
								<Table.Row>
									<Table.Head class="w-40">id</Table.Head>
									{#each selectedTable.columns as column (column.name)}
										<Table.Head class="font-mono text-xs">{column.name}</Table.Head>
									{/each}
									<Table.Head class="w-20 text-right">Actions</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each rows as row (row.id)}
									<Table.Row data-testid={`db-row-${row.id}`}>
										<Table.Cell class="max-w-40 truncate font-mono text-xs text-muted-foreground">
											{row.id}
										</Table.Cell>
										{#each selectedTable.columns as column (column.name)}
											<Table.Cell class="max-w-[14rem] truncate font-mono text-xs">
												{cellText(row.data[column.name])}
											</Table.Cell>
										{/each}
										<Table.Cell class="text-right">
											<div class="flex justify-end gap-1">
												<Button
													variant="ghost"
													size="icon"
													class="h-7 w-7"
													aria-label="Edit row"
													data-testid={`db-row-edit-${row.id}`}
													onclick={() => openEdit(row)}
												>
													<Pencil class="h-3.5 w-3.5" />
												</Button>
												<Button
													variant="ghost"
													size="icon"
													class="h-7 w-7 text-destructive"
													aria-label="Delete row"
													data-testid={`db-row-delete-${row.id}`}
													onclick={() => void deleteRow(row.id)}
												>
													<Trash2 class="h-3.5 w-3.5" />
												</Button>
											</div>
										</Table.Cell>
									</Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					</div>
				{/if}
			</Card.Content>
		</Card.Root>
	{/if}
</div>

<Dialog.Root bind:open={editorOpen}>
	<Dialog.Content class="sm:max-w-xl" data-testid="db-row-editor">
		<Dialog.Header>
			<Dialog.Title class="font-mono text-base">
				{editorRowId ? `Edit row ${editorRowId.slice(0, 10)}…` : `New row in ${selected}`}
			</Dialog.Title>
			<Dialog.Description>
				Column values as JSON. The agent validates against the declared schema and reports every
				issue.
			</Dialog.Description>
		</Dialog.Header>
		<Textarea
			bind:value={editorJson}
			class="min-h-56 font-mono text-xs"
			spellcheck={false}
			data-testid="db-row-json"
		/>
		{#if editorError}
			<p class="text-sm text-destructive" data-testid="db-row-error">{editorError}</p>
		{/if}
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (editorOpen = false)}>Cancel</Button>
			<Button disabled={editorBusy} onclick={() => void saveRow()} data-testid="db-row-save">
				Save row
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={deleteOpen}>
	<Dialog.Content data-testid="db-delete-table-panel">
		<Dialog.Header>
			<Dialog.Title>Delete "{selected}"?</Dialog.Title>
			<Dialog.Description>
				Every row is erased and live subscribers are disconnected. Type the table name to confirm.
			</Dialog.Description>
		</Dialog.Header>
		<Input
			bind:value={deleteConfirm}
			placeholder={selected ?? ''}
			autocomplete="off"
			data-testid="db-delete-table-confirm"
		/>
		{#if deleteError}
			<p class="text-sm text-destructive">{deleteError}</p>
		{/if}
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (deleteOpen = false)}>Cancel</Button>
			<Button
				variant="destructive"
				disabled={deleteBusy || deleteConfirm !== selected}
				onclick={() => void deleteTable()}
				data-testid="db-delete-table-submit"
			>
				Delete table
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
