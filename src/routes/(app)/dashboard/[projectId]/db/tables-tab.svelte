<script lang="ts">
	import type {
		DbColumnType,
		DbDocument,
		DbImportReport,
		DbQueryResult,
		DbReplicationMode,
		DbTableColumn,
		DbTableSummary
	} from '$lib/agents';
	import RollbackDialog from './rollback-dialog.svelte';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Select from '$lib/components/ui/select';
	import * as Sheet from '$lib/components/ui/sheet';
	import { Switch } from '$lib/components/ui/switch';
	import { Textarea } from '$lib/components/ui/textarea';
	import { v7 as uuidv7 } from 'uuid';
	import {
		Braces,
		Clock,
		Download,
		EllipsisVertical,
		Hash,
		History,
		KeyRound,
		Pencil,
		Play,
		Plus,
		RefreshCw,
		Search,
		Table2,
		ToggleLeft,
		Trash2,
		Type,
		Upload,
		X
	} from '@lucide/svelte';

	/**
	 * The Tables workspace: a Supabase-style table editor over the schema-first
	 * SQL tables. The table list is a permanent rail, the data grid IS the page,
	 * and the schema designer opens as a sheet - declaring and altering are ONE
	 * form on purpose, because the admin API takes the full desired schema plus
	 * modes in a single PUT.
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
	const typeIcons = {
		text: Type,
		integer: Hash,
		real: Hash,
		boolean: ToggleLeft,
		json: Braces
	} as const;

	// One class string per grid slot so the header and the body cannot drift.
	const headCell =
		'h-9 border-r border-border/60 px-2.5 text-left align-middle font-medium whitespace-nowrap last:border-r-0';
	const bodyCell =
		'max-w-[16rem] truncate border-r border-border/60 px-2.5 py-1.5 align-middle font-mono text-xs last:border-r-0';

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

	let designerOpen = $state(false);
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

	function openDeclare() {
		resetDesigner();
		designerOpen = true;
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
		designerOpen = true;
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
			const declared = designerFor === null;
			await refresh();
			designerOpen = false;
			resetDesigner();
			// A freshly declared table opens its (empty) grid straight away.
			if (declared) selectTable(name);
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
	let refreshing = $state(false);
	let rowFilter = $state('');
	let tableFilter = $state('');
	let picked = $state<string[]>([]);
	/** Not $state: an in-flight guard must never re-trigger the live effect. */
	let loadingRows = false;

	const selectedTable = $derived(tables.find((table) => table.name === selected) ?? null);
	const visibleTables = $derived(
		tableFilter.trim()
			? tables.filter((table) => table.name.includes(tableFilter.trim().toLowerCase()))
			: tables
	);
	const visibleRows = $derived.by(() => {
		const needle = rowFilter.trim().toLowerCase();
		if (!needle) return rows;
		return rows.filter(
			(row) =>
				row.id.toLowerCase().includes(needle) ||
				JSON.stringify(row.data).toLowerCase().includes(needle)
		);
	});
	const allPicked = $derived(visibleRows.length > 0 && picked.length === visibleRows.length);

	function selectTable(name: string) {
		if (selected === name) return;
		selected = name;
		rows = [];
		picked = [];
		rowFilter = '';
		rowsLoaded = false;
		rowsError = null;
		view = 'grid';
		sqlResults = null;
		sqlError = null;
		importReport = null;
		importError = null;
		seedSqlEditor(name);
	}

	/**
	 * Live rows. The parent hands us a NEW `tables` array on every DbAgent state
	 * sync - shards report their counts ~500ms after a write, from any client -
	 * and on its 5s poll, so reading it here is the refresh signal: the grid
	 * follows writes made in another tab, from the SDK, or over REST, exactly
	 * like the collections browser. Selecting a table drives the same effect.
	 */
	$effect(() => {
		const table = selected;
		// Reading `tables` is the subscription; the length guard is incidental.
		if (!table || tables.length === 0) return;
		void loadRows(table);
	});

	async function loadRows(table: string) {
		if (loadingRows) return;
		loadingRows = true;
		refreshing = true;
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
			// Rows deleted elsewhere must not linger in the selection.
			picked = picked.filter((id) => result.docs.some((doc) => doc.id === id));
			rowsError = null;
		} catch (error) {
			if (selected !== table) return;
			rowsError = error instanceof Error ? error.message : String(error);
		} finally {
			loadingRows = false;
			refreshing = false;
			if (selected === table) rowsLoaded = true;
		}
	}

	function togglePicked(id: string) {
		picked = picked.includes(id) ? picked.filter((other) => other !== id) : [...picked, id];
	}

	function cellText(value: unknown): string {
		if (value === null || value === undefined) return '—';
		if (typeof value === 'boolean') return value ? 'true' : 'false';
		if (typeof value === 'object') return JSON.stringify(value);
		return String(value);
	}

	function shortTime(iso: string): string {
		const at = new Date(iso);
		return Number.isNaN(at.getTime()) ? '—' : at.toLocaleString();
	}

	// -------------------------------------------------------------------------
	// Row editor: a typed field per declared column, with a JSON escape hatch.
	// The agent validates the write against the declared schema either way and
	// returns precise issues, so the form stays permissive on purpose.

	type FieldDraft = {
		name: string;
		type: DbColumnType;
		nullable: boolean;
		hasDefault: boolean;
		text: string;
		bool: boolean;
		isNull: boolean;
	};

	let editorOpen = $state(false);
	let editorRowId = $state<string | null>(null); // null = inserting
	let editorMode = $state<'form' | 'json'>('form');
	let editorFields = $state<FieldDraft[]>([]);
	let editorJson = $state('');
	let editorError = $state<string | null>(null);
	let editorIssues = $state<string[]>([]);
	let editorBusy = $state(false);

	function fieldFor(column: DbTableColumn, value: unknown, inserting: boolean): FieldDraft {
		const nullable = column.nullable !== false;
		const hasDefault = column.default !== undefined && column.default !== null;
		const source = inserting ? (column.default ?? null) : (value ?? null);
		return {
			name: column.name,
			type: column.type,
			nullable,
			hasDefault,
			text:
				source === null
					? ''
					: typeof source === 'object'
						? JSON.stringify(source, null, 2)
						: String(source),
			bool: source === true,
			// NULL is a deliberate choice, never the starting position: a new row
			// opens with every field editable (an empty field simply falls through
			// to the column's default or the agent's "required" message). Editing
			// an existing row shows the NULL it actually holds.
			isNull: !inserting && source === null && column.type !== 'boolean'
		};
	}

	/** One field's value for the write, or the reason it cannot be sent. */
	function fieldValue(field: FieldDraft): { omit: true } | { value: unknown } | { error: string } {
		if (field.isNull) return { value: null };
		switch (field.type) {
			case 'boolean':
				return { value: field.bool };
			case 'integer':
			case 'real': {
				const text = field.text.trim();
				// Blank falls through to the declared default / the agent's
				// "required" message rather than silently becoming 0.
				if (text === '') return { omit: true };
				const numeric = Number(text);
				if (!Number.isFinite(numeric)) return { error: `"${field.name}" must be a number` };
				if (field.type === 'integer' && !Number.isInteger(numeric)) {
					return { error: `"${field.name}" must be a whole number` };
				}
				return { value: numeric };
			}
			case 'json': {
				const text = field.text.trim();
				if (text === '') return { omit: true };
				try {
					return { value: JSON.parse(text) };
				} catch {
					return { error: `"${field.name}" is not valid JSON` };
				}
			}
			default:
				// Blank means "no value" - it falls through to the column's default,
				// or to NULL. A genuinely empty string goes through the JSON view.
				return field.text === '' ? { omit: true } : { value: field.text };
		}
	}

	function fieldsToData(): Record<string, unknown> | string {
		const data: Record<string, unknown> = {};
		for (const field of editorFields) {
			const parsed = fieldValue(field);
			if ('error' in parsed) return parsed.error;
			if ('omit' in parsed) continue;
			data[field.name] = parsed.value;
		}
		return data;
	}

	function setEditorMode(mode: 'form' | 'json') {
		if (mode === editorMode) return;
		if (mode === 'json') {
			const data = fieldsToData();
			// An unparseable field still deserves the raw view - hand over what
			// the operator typed rather than refusing to switch.
			editorJson = JSON.stringify(typeof data === 'string' ? rawFieldMap() : data, null, 2);
			editorError = typeof data === 'string' ? data : null;
		} else {
			try {
				const parsed = JSON.parse(editorJson) as Record<string, unknown>;
				if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
					throw new Error('not an object');
				}
				editorFields = (selectedTable?.columns ?? []).map((column) =>
					fieldFor(column, parsed[column.name], false)
				);
				editorError = null;
			} catch {
				editorError = 'The JSON must be an object of column values to switch back to the form.';
				return;
			}
		}
		editorMode = mode;
	}

	/** Best-effort map of what the form currently holds, unparsed values as text. */
	function rawFieldMap(): Record<string, unknown> {
		const data: Record<string, unknown> = {};
		for (const field of editorFields) {
			data[field.name] = field.isNull ? null : field.type === 'boolean' ? field.bool : field.text;
		}
		return data;
	}

	function openInsert() {
		const columns = selectedTable?.columns ?? [];
		editorRowId = null;
		editorMode = 'form';
		editorFields = columns.map((column) => fieldFor(column, null, true));
		editorJson = JSON.stringify(
			Object.fromEntries(columns.map((column) => [column.name, column.default ?? null])),
			null,
			2
		);
		editorError = null;
		editorIssues = [];
		editorOpen = true;
	}

	function openEdit(row: DbDocument) {
		const columns = selectedTable?.columns ?? [];
		editorRowId = row.id;
		editorMode = 'form';
		editorFields = columns.map((column) => fieldFor(column, row.data[column.name], false));
		editorJson = JSON.stringify(row.data, null, 2);
		editorError = null;
		editorIssues = [];
		editorOpen = true;
	}

	async function saveRow() {
		const table = selected;
		if (!table) return;
		let data: unknown;
		if (editorMode === 'form') {
			const built = fieldsToData();
			if (typeof built === 'string') {
				editorError = built;
				return;
			}
			data = built;
		} else {
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
		}
		editorBusy = true;
		editorError = null;
		editorIssues = [];
		try {
			const id = editorRowId ?? uuidv7();
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
				editorIssues = result?.issues ?? [];
				throw new Error(result?.error ?? `request failed (HTTP ${response.status})`);
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

	// -------------------------------------------------------------------------
	// Row deletion: always confirmed, single or bulk. Deleting rows is the one
	// destructive action the grid offers inline, so it never fires on a click.

	let deleteRowsOpen = $state(false);
	let deleteRowTargets = $state<string[]>([]);
	let deleteRowsBusy = $state(false);
	let deleteRowsError = $state<string | null>(null);

	const deleteRowPreview = $derived(
		deleteRowTargets.length === 1
			? (rows.find((row) => row.id === deleteRowTargets[0]) ?? null)
			: null
	);

	function confirmDeleteRows(ids: string[]) {
		if (ids.length === 0) return;
		deleteRowTargets = ids;
		deleteRowsError = null;
		deleteRowsOpen = true;
	}

	async function deleteRows() {
		const table = selected;
		if (!table || deleteRowTargets.length === 0) return;
		deleteRowsBusy = true;
		deleteRowsError = null;
		try {
			for (const id of deleteRowTargets) {
				const response = await fetch(
					`${adminBase}/tables/${encodeURIComponent(table)}/rows/${encodeURIComponent(id)}`,
					{ method: 'DELETE' }
				);
				if (!response.ok) {
					const result = (await response.json().catch(() => null)) as { error?: string } | null;
					throw new Error(result?.error ?? `request failed (HTTP ${response.status})`);
				}
				// Optimistic: the row leaves the grid before the reload lands.
				rows = rows.filter((row) => row.id !== id);
				picked = picked.filter((other) => other !== id);
			}
			deleteRowsOpen = false;
			deleteRowTargets = [];
			await loadRows(table);
			await refresh();
		} catch (error) {
			deleteRowsError = error instanceof Error ? error.message : String(error);
		} finally {
			deleteRowsBusy = false;
		}
	}

	// -------------------------------------------------------------------------
	// SQL console: the operator surface over POST /admin/tables/:name/sql -
	// the same gate as the public T2 endpoint (single table, no DDL), but
	// operator-authenticated, so the workspace needs no project JWT.

	type SqlStatementResult = {
		results: Record<string, unknown>[];
		columns: string[];
		raw: unknown[][];
		meta: { changes: number; rows_read: number; rows_written: number };
	};
	let view = $state<'grid' | 'sql'>('grid');
	let sqlText = $state('');
	let sqlBusy = $state(false);
	let sqlError = $state<string | null>(null);
	let sqlResults = $state<SqlStatementResult[] | null>(null);

	function seedSqlEditor(table: string) {
		if (!sqlText.trim() || sqlText.startsWith('SELECT * FROM ')) {
			sqlText = `SELECT * FROM ${table} ORDER BY created_at DESC LIMIT 50;`;
		}
	}

	async function runSql() {
		const table = selected;
		const sql = sqlText.trim().replace(/;$/, '');
		if (!table || !sql) return;
		sqlBusy = true;
		sqlError = null;
		try {
			const response = await fetch(`${adminBase}/tables/${encodeURIComponent(table)}/sql`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ sql })
			});
			const body = (await response.json().catch(() => null)) as
				{ success: true; batch: SqlStatementResult[] } | { success: false; error?: string } | null;
			if (!response.ok || !body || body.success !== true) {
				throw new Error(
					(body && 'error' in body && body.error) || `request failed (HTTP ${response.status})`
				);
			}
			sqlResults = body.batch;
			// DML lands in the grid and the stats too.
			await refresh();
			await loadRows(table);
		} catch (error) {
			sqlError = error instanceof Error ? error.message : String(error);
			sqlResults = null;
		} finally {
			sqlBusy = false;
		}
	}

	// -------------------------------------------------------------------------
	// Export / import / rollback: the collection operator surfaces, table-side.

	let importBusy = $state(false);
	let importReport = $state<DbImportReport | null>(null);
	let importError = $state<string | null>(null);
	let importInput = $state<HTMLInputElement | null>(null);
	let rollbackOpen = $state(false);

	async function importTableFile(event: Event) {
		const table = selected;
		const file = (event.target as HTMLInputElement).files?.[0];
		if (!table || !file) return;
		importBusy = true;
		importError = null;
		importReport = null;
		try {
			const response = await fetch(`${adminBase}/tables/${encodeURIComponent(table)}/import`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-ndjson' },
				body: await file.text()
			});
			const result = (await response.json().catch(() => null)) as
				(DbImportReport & { error?: string }) | null;
			if (!response.ok || !result) {
				throw new Error(result?.error ?? `request failed (HTTP ${response.status})`);
			}
			importReport = result;
			await refresh();
			await loadRows(table);
		} catch (error) {
			importError = error instanceof Error ? error.message : String(error);
		} finally {
			importBusy = false;
			if (importInput) importInput.value = '';
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
			picked = [];
			rowsLoaded = false;
			await refresh();
		} catch (error) {
			deleteError = error instanceof Error ? error.message : String(error);
		} finally {
			deleteBusy = false;
		}
	}
</script>

<div class="mt-4 grid grid-cols-1 items-start gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
	<!-- Table rail: the workspace's constant navigator. -->
	<aside class="overflow-hidden rounded-lg border bg-card" data-testid="db-tables-card">
		<div class="flex items-center justify-between gap-2 border-b px-3 py-2">
			<span class="text-xs font-medium tracking-wide text-muted-foreground uppercase">Tables</span>
			<Button
				size="sm"
				variant="ghost"
				class="-mr-1.5 h-7 gap-1 px-2 text-xs"
				data-testid="db-new-table"
				onclick={openDeclare}
			>
				<Plus class="h-3.5 w-3.5" /> New
			</Button>
		</div>

		{#if tables.length > 6}
			<div class="relative border-b px-2 py-1.5">
				<Search
					class="pointer-events-none absolute top-1/2 left-4 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
				/>
				<Input
					class="h-7 pl-7 font-mono text-xs"
					placeholder="Filter tables…"
					autocomplete="off"
					bind:value={tableFilter}
					data-testid="db-table-filter"
				/>
			</div>
		{/if}

		<div class="max-h-96 overflow-y-auto p-1.5" data-testid="db-tables-table">
			{#if tables.length === 0}
				<p
					class="px-2 py-6 text-center text-sm text-muted-foreground"
					data-testid="db-tables-empty"
				>
					No tables yet.
				</p>
			{:else if visibleTables.length === 0}
				<p class="px-2 py-6 text-center text-sm text-muted-foreground">No table matches.</p>
			{:else}
				<ul class="space-y-0.5">
					{#each visibleTables as table (table.name)}
						<li>
							<button
								type="button"
								class={[
									'flex w-full items-center gap-2 rounded-md py-1.5 pr-2 pl-1.5 text-left text-[13px] transition-colors',
									selected === table.name
										? 'bg-muted font-medium text-foreground'
										: 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
								]}
								data-testid={`db-table-${table.name}`}
								onclick={() => selectTable(table.name)}
							>
								<span
									class={[
										'h-4 w-0.5 shrink-0 rounded-full',
										selected === table.name ? 'bg-primary' : 'bg-transparent'
									]}
								></span>
								<Table2
									class={['h-3.5 w-3.5 shrink-0', selected === table.name && 'text-primary']}
								/>
								<span class="min-w-0 flex-1 truncate font-mono">{table.name}</span>
								<span class="text-[11px] tabular-nums opacity-70">{table.rows}</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>

		<div
			class="flex items-center justify-between border-t px-3 py-2 text-[11px] text-muted-foreground tabular-nums"
		>
			<span>{tables.length} {tables.length === 1 ? 'table' : 'tables'}</span>
			<span>{totalRows} {totalRows === 1 ? 'row' : 'rows'}</span>
		</div>
	</aside>

	{#if selected && selectedTable}
		{@const table = selectedTable}
		<section class="min-w-0 overflow-hidden rounded-lg border bg-card" data-testid="db-rows-card">
			<!-- Toolbar -->
			<div class="flex flex-wrap items-center gap-2 border-b px-3 py-2">
				<div class="flex min-w-0 items-center gap-1.5">
					<Table2 class="h-4 w-4 shrink-0 text-primary" />
					<span class="truncate font-mono text-sm font-medium">{selected}</span>
					<span
						class={[
							'ml-1 h-1.5 w-1.5 shrink-0 rounded-full',
							rowsError ? 'bg-destructive' : 'animate-pulse bg-emerald-500'
						]}
						title={rowsError ? 'The last refresh failed' : 'Rows update live'}
					></span>
				</div>

				<div class="ml-auto flex flex-wrap items-center gap-1.5">
					<div class="flex rounded-md border p-0.5" role="tablist" aria-label="Table view">
						{#each [['grid', 'Data'], ['sql', 'SQL']] as option (option[0])}
							<button
								type="button"
								role="tab"
								aria-selected={view === option[0]}
								class={[
									'rounded px-2.5 py-1 text-xs font-medium transition-colors',
									view === option[0]
										? 'bg-muted text-foreground'
										: 'text-muted-foreground hover:text-foreground'
								]}
								data-testid={`db-view-${option[0]}`}
								onclick={() => (view = option[0] as 'grid' | 'sql')}
							>
								{option[1]}
							</button>
						{/each}
					</div>

					{#if view === 'grid'}
						<div class="relative">
							<Search
								class="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
							/>
							<Input
								class="h-8 w-36 pl-7 text-xs sm:w-44"
								placeholder="Search rows…"
								autocomplete="off"
								bind:value={rowFilter}
								data-testid="db-row-filter"
							/>
						</div>
					{/if}

					<Button size="sm" class="h-8" onclick={openInsert} data-testid="db-add-row">
						<Plus class="h-3.5 w-3.5" /> Insert
					</Button>
					<Button
						size="sm"
						variant="outline"
						class="h-8"
						data-testid="db-edit-schema"
						onclick={() => openAlter(table)}
					>
						<Pencil class="h-3.5 w-3.5" /><span class="max-sm:sr-only">Schema</span>
					</Button>

					<input
						bind:this={importInput}
						type="file"
						accept=".ndjson,.jsonl,.txt,application/x-ndjson"
						class="hidden"
						onchange={importTableFile}
					/>
					<DropdownMenu.Root>
						<DropdownMenu.Trigger>
							{#snippet child({ props })}
								<Button
									{...props}
									size="icon"
									variant="outline"
									class="h-8 w-8"
									aria-label="More table actions"
									data-testid="db-table-actions"
								>
									<EllipsisVertical class="h-4 w-4" />
								</Button>
							{/snippet}
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="end" class="w-48">
							<DropdownMenu.Item
								data-testid="db-table-rollback"
								onclick={() => (rollbackOpen = true)}
							>
								<History class="h-4 w-4" /> Roll back in time
							</DropdownMenu.Item>
							<DropdownMenu.Separator />
							<DropdownMenu.Item
								data-testid="db-table-export"
								onclick={() =>
									selected &&
									(window.location.href = `${adminBase}/tables/${encodeURIComponent(selected)}/export`)}
							>
								<Download class="h-4 w-4" /> Export NDJSON
							</DropdownMenu.Item>
							<DropdownMenu.Item
								data-testid="db-table-import"
								disabled={importBusy}
								onclick={() => importInput?.click()}
							>
								<Upload class="h-4 w-4" />
								{importBusy ? 'Importing…' : 'Import NDJSON'}
							</DropdownMenu.Item>
							<DropdownMenu.Separator />
							<DropdownMenu.Item
								variant="destructive"
								data-testid="db-delete-table"
								onclick={() => {
									deleteConfirm = '';
									deleteError = null;
									deleteOpen = true;
								}}
							>
								<Trash2 class="h-4 w-4" /> Delete table
							</DropdownMenu.Item>
						</DropdownMenu.Content>
					</DropdownMenu.Root>
				</div>
			</div>

			<!-- Schema strip: what the grid is showing, at a glance. -->
			<div
				class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground"
			>
				<span class="tabular-nums">{table.columns.length} columns</span>
				<span class="text-border">·</span>
				<span>read <span class="font-mono text-foreground/80">{table.readAccess}</span></span>
				<span>write <span class="font-mono text-foreground/80">{table.writeAccess}</span></span>
				<span class="text-border">·</span>
				<span>
					replication
					<span class="font-mono text-foreground/80">{table.replication}</span>
				</span>
				{#if table.readPermission || table.writePermission}
					<span class="text-border">·</span>
					<span class="font-mono text-foreground/80">
						{[table.readPermission, table.writePermission].filter(Boolean).join(' / ')}
					</span>
				{/if}
			</div>

			{#if rowsError}
				<p
					class="border-b bg-destructive/5 px-3 py-2 text-xs text-destructive"
					data-testid="db-rows-error"
				>
					{rowsError}
				</p>
			{/if}
			{#if importError}
				<p
					class="border-b bg-destructive/5 px-3 py-2 text-xs text-destructive"
					data-testid="db-table-import-error"
				>
					{importError}
				</p>
			{/if}
			{#if importReport}
				<p
					class="border-b px-3 py-2 text-xs text-muted-foreground"
					data-testid="db-table-import-result"
				>
					Imported {importReport.imported} new and replaced {importReport.updated} rows{importReport
						.errors.length
						? `; ${importReport.errors.length} lines failed (first: line ${importReport.errors[0].line} - ${importReport.errors[0].error})`
						: '.'}
				</p>
			{/if}

			{#if view === 'sql'}
				<div class="space-y-3 p-3">
					<Textarea
						bind:value={sqlText}
						class="min-h-32 font-mono text-xs"
						spellcheck={false}
						placeholder={`SELECT * FROM ${selected} LIMIT 50;`}
						data-testid="db-sql-editor"
					/>
					<div class="flex flex-wrap items-center gap-2">
						<Button
							size="sm"
							disabled={sqlBusy || !sqlText.trim()}
							onclick={() => void runSql()}
							data-testid="db-sql-run"
						>
							<Play class="h-3.5 w-3.5" /> Run
						</Button>
						<p class="text-xs text-muted-foreground">
							One SELECT/INSERT/UPDATE/DELETE over
							<span class="font-mono">{selected}</span> - operator-grade, no DDL. System columns:
							<span class="font-mono">id · owner · created_at · updated_at</span>.
						</p>
					</div>
					{#if sqlError}
						<p class="text-sm text-destructive" data-testid="db-sql-error">{sqlError}</p>
					{/if}
					{#each sqlResults ?? [] as statement, statementIndex (statementIndex)}
						<div class="space-y-1">
							<p class="text-xs text-muted-foreground tabular-nums">
								{statement.results.length}
								{statement.results.length === 1 ? 'row' : 'rows'} · {statement.meta.rows_read} read ·
								{statement.meta.rows_written} written
							</p>
							{#if statement.results.length > 0}
								<div class="max-h-80 overflow-auto rounded-md border">
									<table class="w-full border-collapse text-xs" data-testid="db-sql-results">
										<thead class="sticky top-0 z-10 bg-muted/60 backdrop-blur">
											<tr class="border-b">
												{#each statement.columns as column (column)}
													<th class="{headCell} font-mono text-[11px] text-muted-foreground">
														{column}
													</th>
												{/each}
											</tr>
										</thead>
										<tbody>
											{#each statement.raw as row, rowIndex (rowIndex)}
												<tr class="border-b last:border-b-0 hover:bg-muted/40">
													{#each row as value, valueIndex (valueIndex)}
														<td class={bodyCell} title={cellText(value)}>{cellText(value)}</td>
													{/each}
												</tr>
											{/each}
										</tbody>
									</table>
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{:else if !rowsLoaded}
				<p class="py-16 text-center text-sm text-muted-foreground">Loading rows…</p>
			{:else if rows.length === 0}
				<div
					class="flex flex-col items-center gap-3 px-6 py-16 text-center"
					data-testid="db-rows-empty"
				>
					<div class="rounded-lg bg-muted p-2.5 text-muted-foreground">
						<Table2 class="h-5 w-5" />
					</div>
					<div>
						<p class="text-sm font-medium">No rows yet</p>
						<p class="mt-1 text-xs text-muted-foreground">
							Insert one here, or write to
							<span class="font-mono">{selected}</span> from the SDK - the grid follows live.
						</p>
					</div>
					<Button size="sm" variant="outline" onclick={openInsert}>
						<Plus class="h-3.5 w-3.5" /> Insert row
					</Button>
				</div>
			{:else}
				<!-- Data grid: typed column headers from the DECLARED schema (SQLite
				     affinity is not the type system - the DSL is), sticky while the
				     grid scrolls, NULLs rendered as NULLs. -->
				<div class="max-h-[60vh] min-h-48 overflow-auto">
					<table class="w-full border-collapse text-xs" data-testid="db-rows-table">
						<thead class="sticky top-0 z-20">
							<tr class="border-b bg-muted/60 backdrop-blur">
								<th class="{headCell} sticky left-0 z-30 w-9 bg-muted/95 px-2">
									<Checkbox
										checked={allPicked}
										indeterminate={picked.length > 0 && !allPicked}
										aria-label="Select every row"
										data-testid="db-rows-select-all"
										onCheckedChange={(checked) => {
											picked = checked ? visibleRows.map((row) => row.id) : [];
										}}
									/>
								</th>
								<th class="{headCell} w-44">
									<span class="flex items-center gap-1.5">
										<KeyRound class="h-3 w-3 text-muted-foreground" />
										<span class="font-mono">id</span>
										<span class="text-[10px] font-normal text-muted-foreground/70">uuid</span>
									</span>
								</th>
								{#each table.columns as column (column.name)}
									{@const Icon = typeIcons[column.type]}
									<th class={headCell}>
										<span class="flex items-center gap-1.5">
											<Icon class="h-3 w-3 text-muted-foreground" />
											<span class="font-mono">{column.name}</span>
											<span class="text-[10px] font-normal text-muted-foreground/70">
												{column.type}{column.nullable === false ? '' : '?'}
											</span>
											{#if column.unique}
												<span
													class="rounded-sm bg-primary/10 px-1 text-[9px] font-medium tracking-wide text-primary uppercase"
													>uq</span
												>
											{/if}
										</span>
									</th>
								{/each}
								<th class={headCell}>
									<span class="flex items-center gap-1.5">
										<Clock class="h-3 w-3 text-muted-foreground" />
										<span class="font-mono">created_at</span>
									</span>
								</th>
								<th class="{headCell} w-16 text-right">
									<span class="sr-only">Row actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{#each visibleRows as row (row.id)}
								{@const isPicked = picked.includes(row.id)}
								<tr
									class={[
										'group border-b transition-colors last:border-b-0',
										isPicked ? 'bg-primary/5' : 'hover:bg-muted/40'
									]}
									data-testid={`db-row-${row.id}`}
								>
									<td
										class={[
											'sticky left-0 z-10 w-9 border-r border-border/60 px-2 py-1.5 align-middle',
											isPicked ? 'bg-primary/5' : 'bg-card group-hover:bg-muted/40'
										]}
									>
										<Checkbox
											checked={isPicked}
											aria-label={`Select row ${row.id}`}
											data-testid={`db-row-pick-${row.id}`}
											onCheckedChange={() => togglePicked(row.id)}
										/>
									</td>
									<td class="{bodyCell} w-44 text-muted-foreground" title={row.id}>{row.id}</td>
									{#each table.columns as column (column.name)}
										{@const value = row.data[column.name]}
										<td class={bodyCell} title={cellText(value)}>
											{#if value === null || value === undefined}
												<span class="text-muted-foreground/50 italic">NULL</span>
											{:else if typeof value === 'boolean'}
												<span
													class={[
														'rounded-sm px-1.5 py-0.5 text-[10px] font-medium',
														value
															? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
															: 'bg-muted text-muted-foreground'
													]}
												>
													{value ? 'true' : 'false'}
												</span>
											{:else}
												{cellText(value)}
											{/if}
										</td>
									{/each}
									<td class="{bodyCell} text-muted-foreground">{shortTime(row.createdAt)}</td>
									<td class="w-16 px-2 py-1 text-right align-middle">
										<div
											class="flex justify-end gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 max-lg:opacity-100"
										>
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
												class="h-7 w-7 text-destructive hover:text-destructive"
												aria-label="Delete row"
												data-testid={`db-row-delete-${row.id}`}
												onclick={() => confirmDeleteRows([row.id])}
											>
												<Trash2 class="h-3.5 w-3.5" />
											</Button>
										</div>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
					{#if visibleRows.length === 0}
						<p class="py-10 text-center text-sm text-muted-foreground">
							No row matches "{rowFilter}".
						</p>
					{/if}
				</div>
			{/if}

			<!-- Status bar: selection actions live here so the grid never shifts. -->
			{#if view === 'grid' && rowsLoaded && rows.length > 0}
				<div class="flex flex-wrap items-center gap-2 border-t px-3 py-1.5 text-[11px]">
					{#if picked.length > 0}
						<span class="font-medium tabular-nums" data-testid="db-rows-picked">
							{picked.length} selected
						</span>
						<Button
							size="sm"
							variant="destructive"
							class="h-6 gap-1 px-2 text-[11px]"
							data-testid="db-rows-bulk-delete"
							onclick={() => confirmDeleteRows(picked)}
						>
							<Trash2 class="h-3 w-3" /> Delete {picked.length}
						</Button>
						<Button
							size="sm"
							variant="ghost"
							class="h-6 px-2 text-[11px]"
							onclick={() => (picked = [])}
						>
							Clear
						</Button>
					{:else}
						<span class="text-muted-foreground tabular-nums">
							{visibleRows.length}
							{visibleRows.length === 1 ? 'row' : 'rows'}{rowFilter.trim()
								? ` of ${rows.length}`
								: ''} · newest page of 50
						</span>
					{/if}
					<div class="ml-auto flex items-center gap-2 text-muted-foreground">
						<span class="flex items-center gap-1.5">
							<span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span> Live
						</span>
						<Button
							size="icon"
							variant="ghost"
							class="h-6 w-6"
							aria-label="Refresh rows"
							data-testid="db-rows-refresh"
							onclick={() => selected && void loadRows(selected)}
						>
							<RefreshCw class={['h-3 w-3', refreshing && 'animate-spin']} />
						</Button>
					</div>
				</div>
			{/if}
		</section>
	{:else}
		<!-- Nothing open: the workspace explains itself instead of a blank pane. -->
		<section
			class="flex min-h-80 flex-col items-center justify-center gap-3 rounded-lg border border-dashed bg-card/40 px-6 py-16 text-center"
			data-testid="db-tables-placeholder"
		>
			<div class="rounded-lg bg-muted p-2.5 text-muted-foreground">
				<Table2 class="h-5 w-5" />
			</div>
			<div class="max-w-sm">
				<p class="text-sm font-medium">
					{tables.length === 0 ? 'No tables yet' : 'Select a table'}
				</p>
				<p class="mt-1 text-xs text-muted-foreground">
					Declare typed columns up front and get unique indexes, ORM-compatible storage, and the
					same live queries collections have.
				</p>
			</div>
			<Button size="sm" data-testid="db-new-table-empty" onclick={openDeclare}>
				<Plus class="h-3.5 w-3.5" /> New table
			</Button>
		</section>
	{/if}
</div>

<!-- Schema designer: declare and alter, one PUT either way. -->
<Sheet.Root bind:open={designerOpen}>
	<Sheet.Content
		side="right"
		class="w-full gap-0 p-0 sm:max-w-lg data-[side=right]:sm:max-w-lg"
		data-testid="db-declare-table"
	>
		<Sheet.Header class="gap-1 border-b px-5 py-4">
			<Sheet.Title class="text-base">
				{designerFor ? `Schema of "${designerFor}"` : 'Declare a table'}
			</Sheet.Title>
			<Sheet.Description>
				{designerFor
					? 'Add columns or toggle indexes. Destructive changes are refused - export and recreate instead.'
					: 'The full schema up front: typed columns, defaults, unique and secondary indexes.'}
			</Sheet.Description>
		</Sheet.Header>

		<form class="flex min-h-0 flex-1 flex-col" onsubmit={submitDesigner}>
			<div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
				{#if !designerFor}
					<div class="space-y-1.5">
						<Label for="new-table-name">Name</Label>
						<Input
							id="new-table-name"
							class="font-mono"
							bind:value={designerName}
							placeholder="table name…"
							autocomplete="off"
							data-testid="db-new-table-name"
						/>
					</div>
				{/if}

				<div class="space-y-2">
					<div class="flex items-center justify-between">
						<Label>Columns</Label>
						<span class="text-[11px] text-muted-foreground tabular-nums">
							{designerColumns.length}/64
						</span>
					</div>

					<p
						class="rounded-md border border-dashed px-2.5 py-1.5 text-[11px] text-muted-foreground"
					>
						System columns are always there:
						<span class="font-mono text-foreground/70">id · owner · created_at · updated_at</span>
					</p>

					{#each designerColumns as column, index (index)}
						{@const Icon = typeIcons[column.type]}
						<div class="space-y-2 rounded-md border p-2" data-testid={`db-column-${index}`}>
							<div class="flex items-center gap-1.5">
								<Icon class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
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
									<Select.Trigger class="h-8 w-24 text-xs" data-testid={`db-column-type-${index}`}>
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
									aria-label={`Remove column ${index + 1}`}
									onclick={() => {
										designerColumns = designerColumns.filter((_, i) => i !== index);
									}}
								>
									<X class="h-3.5 w-3.5" />
								</Button>
							</div>
							<div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-5 text-xs">
								<label class="flex items-center gap-1.5">
									<Checkbox bind:checked={column.nullable} class="size-3.5" />
									<span class="text-muted-foreground">nullable</span>
								</label>
								<label class="flex items-center gap-1.5">
									<Checkbox bind:checked={column.unique} class="size-3.5" />
									<span class="text-muted-foreground">unique</span>
								</label>
								<label class="flex items-center gap-1.5">
									<Checkbox bind:checked={column.index} class="size-3.5" />
									<span class="text-muted-foreground">index</span>
								</label>
								{#if column.type !== 'json'}
									<Input
										class="h-7 w-28 font-mono text-xs"
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
							<Select.Trigger class="w-full font-mono" data-testid="db-new-table-read">
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
							<Select.Trigger class="w-full font-mono" data-testid="db-new-table-write">
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

				<p
					class="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
					data-testid="db-table-access-sentence"
				>
					{designerSentence}
				</p>

				{#if designerError}
					<p class="text-sm text-destructive" data-testid="db-declare-error">{designerError}</p>
				{/if}
			</div>

			<div class="flex items-center gap-2 border-t px-5 py-3">
				<Button type="submit" disabled={designerBusy} data-testid="db-declare-submit">
					<Plus class="h-4 w-4" />
					{designerFor ? 'Apply changes' : 'Declare table'}
				</Button>
				<Button type="button" variant="ghost" onclick={() => (designerOpen = false)}>Cancel</Button>
			</div>
		</form>
	</Sheet.Content>
</Sheet.Root>

<!-- Row editor: typed fields per declared column, JSON as the escape hatch. -->
<Dialog.Root bind:open={editorOpen}>
	<Dialog.Content class="gap-4 sm:max-w-2xl" data-testid="db-row-editor">
		<Dialog.Header class="gap-1">
			<Dialog.Title class="text-base">
				{editorRowId ? 'Edit row' : `Insert row into ${selected}`}
			</Dialog.Title>
			<Dialog.Description>
				{#if editorRowId}
					<span class="font-mono text-xs">{editorRowId}</span>
				{:else}
					Values are checked against the declared schema; the agent reports every issue.
				{/if}
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex w-fit rounded-md border p-0.5" role="tablist" aria-label="Row editor mode">
			{#each [['form', 'Form'], ['json', 'JSON']] as option (option[0])}
				<button
					type="button"
					role="tab"
					aria-selected={editorMode === option[0]}
					class={[
						'rounded px-2.5 py-1 text-xs font-medium transition-colors',
						editorMode === option[0]
							? 'bg-muted text-foreground'
							: 'text-muted-foreground hover:text-foreground'
					]}
					data-testid={`db-row-mode-${option[0]}`}
					onclick={() => setEditorMode(option[0] as 'form' | 'json')}
				>
					{option[1]}
				</button>
			{/each}
		</div>

		{#if editorMode === 'form'}
			<div class="-mr-2 max-h-[55vh] space-y-3 overflow-y-auto pr-2">
				{#each editorFields as field (field.name)}
					{@const Icon = typeIcons[field.type]}
					<div class="grid gap-1.5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-start sm:gap-3">
						<div class="flex items-center gap-1.5 pt-1.5">
							<Icon class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
							<span class="truncate font-mono text-xs">{field.name}</span>
							{#if !field.nullable && !field.hasDefault}
								<span class="text-destructive" title="Required">*</span>
							{/if}
							<span class="ml-auto text-[10px] text-muted-foreground/70">{field.type}</span>
						</div>
						<div class="flex items-start gap-2">
							{#if field.type === 'boolean'}
								<div class="flex h-8 items-center">
									<Switch bind:checked={field.bool} disabled={field.isNull} />
									<span class="ml-2 font-mono text-xs text-muted-foreground">
										{field.isNull ? 'null' : field.bool ? 'true' : 'false'}
									</span>
								</div>
							{:else if field.type === 'json'}
								<Textarea
									class="min-h-16 font-mono text-xs"
									spellcheck={false}
									placeholder={'{ }'}
									bind:value={field.text}
									disabled={field.isNull}
									data-testid={`db-row-field-${field.name}`}
								/>
							{:else}
								<Input
									class="h-8 font-mono text-xs"
									autocomplete="off"
									inputmode={field.type === 'text' ? undefined : 'decimal'}
									bind:value={field.text}
									disabled={field.isNull}
									data-testid={`db-row-field-${field.name}`}
								/>
							{/if}
							{#if field.nullable}
								<label
									class="flex h-8 shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground"
								>
									<Checkbox
										checked={field.isNull}
										class="size-3.5"
										data-testid={`db-row-null-${field.name}`}
										onCheckedChange={(checked) => (field.isNull = checked === true)}
									/>
									NULL
								</label>
							{/if}
						</div>
					</div>
				{/each}
				{#if editorFields.length === 0}
					<p class="py-6 text-center text-sm text-muted-foreground">
						This table declares no columns yet.
					</p>
				{/if}
			</div>
		{:else}
			<Textarea
				bind:value={editorJson}
				class="min-h-56 font-mono text-xs"
				spellcheck={false}
				data-testid="db-row-json"
			/>
		{/if}

		{#if editorError}
			<div class="space-y-1" data-testid="db-row-error">
				<p class="text-sm text-destructive">{editorError}</p>
				{#each editorIssues as issue (issue)}
					<p class="text-xs text-destructive/80">· {issue}</p>
				{/each}
			</div>
		{/if}

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (editorOpen = false)}>Cancel</Button>
			<Button disabled={editorBusy} onclick={() => void saveRow()} data-testid="db-row-save">
				{editorRowId ? 'Save changes' : 'Insert row'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<!-- Row deletion is always confirmed - single row or a whole selection. -->
<AlertDialog.Root bind:open={deleteRowsOpen}>
	<AlertDialog.Content data-testid="db-delete-rows-panel">
		<AlertDialog.Header>
			<AlertDialog.Title>
				{deleteRowTargets.length === 1
					? 'Delete this row?'
					: `Delete ${deleteRowTargets.length} rows?`}
			</AlertDialog.Title>
			<AlertDialog.Description>
				This cannot be undone from here - a point-in-time rollback is the only way back.
			</AlertDialog.Description>
		</AlertDialog.Header>

		{#if deleteRowPreview}
			<div class="max-h-40 overflow-auto rounded-md border bg-muted/40 p-2.5">
				<p class="font-mono text-[11px] text-muted-foreground">{deleteRowPreview.id}</p>
				<pre class="mt-1 font-mono text-[11px] break-all whitespace-pre-wrap">{JSON.stringify(
						deleteRowPreview.data,
						null,
						2
					)}</pre>
			</div>
		{:else}
			<p class="font-mono text-xs text-muted-foreground">
				{deleteRowTargets.length} selected rows in {selected}
			</p>
		{/if}

		{#if deleteRowsError}
			<p class="text-sm text-destructive" data-testid="db-delete-rows-error">{deleteRowsError}</p>
		{/if}

		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={deleteRowsBusy}>Cancel</AlertDialog.Cancel>
			<Button
				variant="destructive"
				disabled={deleteRowsBusy}
				data-testid="db-delete-rows-submit"
				onclick={() => void deleteRows()}
			>
				{deleteRowsBusy
					? 'Deleting…'
					: deleteRowTargets.length === 1
						? 'Delete row'
						: `Delete ${deleteRowTargets.length} rows`}
			</Button>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

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
			class="font-mono"
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

{#if selected}
	<RollbackDialog
		bind:open={rollbackOpen}
		base={`${adminBase}/tables/${encodeURIComponent(selected)}`}
		shardName={selected}
		noun="table"
		onRestored={async () => {
			await refresh();
			if (selected) await loadRows(selected);
		}}
	/>
{/if}
