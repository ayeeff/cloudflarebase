<script lang="ts">
	import { browser, dev } from '$app/environment';
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import type {
		DbAccessMode,
		DbAgentState,
		DbReplicationMode,
		DbDocument,
		DbFieldRule,
		DbImportReport,
		DbOverview,
		DbQueryResult,
		DbRestorePoint,
		DbRestorePoints,
		DbValidator
	} from '$lib/agents';
	import { dbAccessModeSchema, dbValidatorSchema } from '$lib/agents';
	import CodeExamples from '$lib/components/code-examples.svelte';
	import ReplicationTab from './replication-tab.svelte';
	import TablesTab from './tables-tab.svelte';
	import { ulid } from '$lib/ulid';
	import type { CodeExample } from '$lib/integration-examples';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Calendar } from '$lib/components/ui/calendar';
	import * as Card from '$lib/components/ui/card';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Popover from '$lib/components/ui/popover';
	import { getLocalTimeZone, parseDate, today } from '@internationalized/date';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import * as Select from '$lib/components/ui/select';
	import * as Table from '$lib/components/ui/table';
	import { Textarea } from '$lib/components/ui/textarea';
	import {
		Activity,
		BookmarkPlus,
		Calendar as CalendarIcon,
		Database,
		Download,
		EllipsisVertical,
		FileText,
		FolderPlus,
		History,
		Pencil,
		Plus,
		Radio,
		Rocket,
		ShieldCheck,
		Trash2,
		Upload,
		X
	} from '@lucide/svelte';
	import { AgentClient } from 'agents/client';
	import { onMount, tick } from 'svelte';

	let { data } = $props();
	let hydrated = $state(false);

	// Tab and browsed collection restore from the query string AT INIT, not in
	// onMount: page.url is the request URL during SSR, so the server already
	// renders the right tab and the reload never flashes the default first.
	const initialTab = page.url.searchParams.get('tab');
	const initialCollection = page.url.searchParams.get('collection');

	onMount(() => {
		hydrated = true;
		void loadPermissions();
		// Documents can only load client-side; the card itself was SSR'd.
		if (selected) void loadDocuments(selected);
	});

	/** Mirror UI state into the query string without history spam. */
	function persistQueryParam(key: string, value: string | null) {
		if (!browser) return;
		try {
			const url = new URL(window.location.href);
			if (value) url.searchParams.set(key, value);
			else url.searchParams.delete(key);
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- same-page query param, not a route
			replaceState(url, {});
		} catch {
			// router not ready (first paint) - the selection itself still works
		}
	}

	function setActiveTab(tab: string) {
		activeTab = tab;
		persistQueryParam('tab', tab === 'collections' ? null : tab);
	}

	// Initial values from the server load; kept in sync on navigation by the
	// $effect below and updated live via WebSocket state sync.
	// svelte-ignore state_referenced_locally
	let overview = $state<DbOverview>(data.overview);
	// svelte-ignore state_referenced_locally
	let agentState = $state<DbAgentState>(data.overview.state);
	let live = $state(false);
	let activeTab = $state(
		initialTab === 'tables' ||
			initialTab === 'access' ||
			initialTab === 'replication' ||
			initialTab === 'setup'
			? initialTab
			: 'collections'
	);
	let busy = $state(false);

	// Document browser: which collection is open, and its latest page of docs.
	let selected = $state<string | null>(
		initialCollection && /^[a-z][a-z0-9_-]{0,63}$/.test(initialCollection)
			? initialCollection
			: null
	);
	let documents = $state<DbDocument[]>([]);
	let docsLoaded = $state(false);
	let docsError = $state<string | null>(null);
	let actionError = $state<string | null>(null);

	// Keep the snapshot in sync with the load, but only reset the browser when
	// the PROJECT actually changes - on first mount this effect runs after
	// onMount, and resetting then would wipe the ?collection= restore.
	// svelte-ignore state_referenced_locally
	let lastProject = data.projectId;
	$effect(() => {
		overview = data.overview;
		agentState = data.overview.state;
		if (data.projectId !== lastProject) {
			lastProject = data.projectId;
			closeBrowser();
		}
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
		deletePanelOpen = false;
		deleteConfirmInput = '';
		deleteError = null;
		importReport = null;
		importError = null;
		rollbackOpen = false;
		persistQueryParam('collection', null);
	}

	function selectCollection(name: string, options: { persist?: boolean } = {}) {
		if (selected === name) {
			closeBrowser();
			return;
		}
		closeBrowser();
		selected = name;
		if (options.persist !== false) persistQueryParam('collection', name);
		void loadDocuments(name);
		// The documents card mounts below the collections grid - off-screen on
		// phones, where a tap would otherwise appear to do nothing. Scroll the
		// shell's ScrollArea viewport, NEVER the window: the app shell is
		// viewport-height, and window scrolling shoves the layout past the
		// mobile tab bar.
		void tick().then(() => {
			const card = document.querySelector('[data-testid="db-documents-card"]');
			if (!(card instanceof HTMLElement)) return;
			const viewport = card.closest('[data-slot="scroll-area-viewport"]');
			if (viewport instanceof HTMLElement) {
				const top =
					card.getBoundingClientRect().top -
					viewport.getBoundingClientRect().top +
					viewport.scrollTop;
				viewport.scrollTo({ top: Math.max(0, top - 12), behavior: 'smooth' });
			}
		});
	}

	// Collection create / access-mode configuration. Both go through the same
	// PUT /admin/collections/:name upsert on the agent.
	const accessModes: DbAccessMode[] = ['public', 'auth', 'owner'];

	// Permission keys actually granted by this project's roles (Auth > Roles):
	// the permission selects offer real grants instead of free-typed text.
	// Sentinel because a Select item cannot carry the empty string.
	const NO_PERMISSION = '__none__';
	let projectPermissions = $state<string[]>([]);

	async function loadPermissions() {
		try {
			const response = await fetch(`/api/projects/${data.projectId}/overview`);
			if (!response.ok) return;
			const overview = (await response.json()) as {
				state?: { roles?: { permissions: string[] }[] };
			};
			const keys: Record<string, true> = {};
			for (const role of overview.state?.roles ?? []) {
				for (const key of role.permissions) keys[key] = true;
			}
			projectPermissions = Object.keys(keys).sort();
		} catch {
			// the selects still offer none + whatever is already stored
		}
	}

	/** Registry keys plus the stored value (in case its role was deleted). */
	function permissionOptions(current: string): string[] {
		const keys: Record<string, true> = {};
		for (const key of projectPermissions) keys[key] = true;
		if (current.trim()) keys[current.trim()] = true;
		return Object.keys(keys).sort();
	}

	function toAccessMode(value: string): DbAccessMode {
		const parsed = dbAccessModeSchema.safeParse(value);
		return parsed.success ? parsed.data : 'owner';
	}

	async function saveCollectionConfig(
		name: string,
		config: {
			readAccess: DbAccessMode;
			writeAccess: DbAccessMode;
			// Omitted = unchanged on the agent; explicit null clears.
			readPermission?: string | null;
			writePermission?: string | null;
			validator?: DbValidator | null;
			replication?: DbReplicationMode;
		}
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
		// The agent route is an upsert on purpose (the Access tab reuses it);
		// the CREATE form must not silently reconfigure an existing collection.
		if (agentState.collections.some((collection) => collection.name === name)) {
			createError = `Collection "${name}" already exists - click its row to browse it, or change its rules under Access.`;
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
	// Permission keys ride along with the modes ('' = none); the validator is
	// edited in its own dialog and deliberately NOT sent by Apply (omitted =
	// unchanged on the agent), so the two saves cannot clobber each other.
	type AccessEdit = {
		readAccess: DbAccessMode;
		writeAccess: DbAccessMode;
		readPermission: string;
		writePermission: string;
		replication: DbReplicationMode;
	};
	let accessEdits = $state<Record<string, AccessEdit>>({});
	let accessFeedback = $state<Record<string, { ok: boolean; message: string }>>({});

	function currentAccess(name: string): AccessEdit {
		const summary = agentState.collections.find((collection) => collection.name === name);
		return (
			accessEdits[name] ?? {
				readAccess: summary?.readAccess ?? 'owner',
				writeAccess: summary?.writeAccess ?? 'owner',
				readPermission: summary?.readPermission ?? '',
				writePermission: summary?.writePermission ?? '',
				replication: summary?.replication ?? 'auto'
			}
		);
	}

	function setAccessField<K extends keyof AccessEdit>(name: string, kind: K, value: AccessEdit[K]) {
		accessEdits[name] = { ...currentAccess(name), [kind]: value };
	}

	/**
	 * The teaching device of the Access tab: the current (possibly pending)
	 * configuration restated as one plain-English sentence, updated live as
	 * the selects change - so nobody has to decode mode names.
	 */
	function accessSentence(pending: AccessEdit, hasRules: boolean): string {
		const withKey = (key: string) => (key.trim() ? ` whose role grants ${key.trim()}` : '');
		const read =
			pending.readAccess === 'public'
				? 'anyone can read every document'
				: pending.readAccess === 'auth'
					? `any signed-in user${withKey(pending.readPermission)} can read every document`
					: `signed-in users${withKey(pending.readPermission)} can read only documents they created`;
		const write =
			pending.writeAccess === 'public'
				? 'anyone can create, edit, and delete documents'
				: pending.writeAccess === 'auth'
					? `any signed-in user${withKey(pending.writePermission)} can create, edit, and delete any document`
					: `signed-in users${withKey(pending.writePermission)} can create documents but edit or delete only their own`;
		const replication =
			pending.replication === 'auto'
				? ' Reads are served from a replica in the reader’s region.'
				: ' Replication is off - every read travels to the primary.';
		return `Read: ${read}. Write: ${write}.${hasRules ? ' New writes must also pass the document rules.' : ''}${replication}`;
	}

	async function applyAccess(name: string) {
		busy = true;
		const pending = currentAccess(name);
		const message = await saveCollectionConfig(name, {
			readAccess: pending.readAccess,
			writeAccess: pending.writeAccess,
			readPermission: pending.readPermission.trim() || null,
			writePermission: pending.writePermission.trim() || null,
			replication: pending.replication
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

	// Rules-lite validator editor: JSON in a dialog, validated client-side
	// with the same schema shape the agent enforces.
	let rulesFor = $state<string | null>(null);
	let rulesJson = $state('');
	let rulesError = $state<string | null>(null);
	/** Only for EMPTY collections; anything with documents gets a template
	 * inferred from its real shape instead of a puzzling generic example. */
	const RULES_TEMPLATE = JSON.stringify(
		{ fields: { title: { type: 'string', required: true } }, additionalFields: 'allow' },
		null,
		2
	);

	function jsonTypeOf(value: unknown): DbFieldRule['type'] {
		if (value === null) return 'null';
		if (Array.isArray(value)) return 'array';
		const kind = typeof value;
		if (kind === 'string' || kind === 'number' || kind === 'boolean') return kind;
		return kind === 'object' ? 'object' : 'any';
	}

	/** Seed a validator from real documents: one rule per top-level field,
	 * typed when the type is consistent across the sample, required when
	 * every sampled document carries the field. Plain objects, not Map/Set -
	 * svelte/prefer-svelte-reactivity flags those even for pure local math. */
	function inferValidator(docs: DbDocument[]): DbValidator | null {
		const kindsByField: Record<string, Record<string, true>> = {};
		const seenIn: Record<string, number> = {};
		for (const doc of docs) {
			for (const [key, value] of Object.entries(doc.data)) {
				if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) || value === undefined) continue;
				(kindsByField[key] ??= {})[jsonTypeOf(value)] = true;
				seenIn[key] = (seenIn[key] ?? 0) + 1;
			}
		}
		const fields: DbValidator['fields'] = {};
		for (const [key, kinds] of Object.entries(kindsByField).slice(0, 20)) {
			const kindNames = Object.keys(kinds);
			fields[key] = {
				type: kindNames.length === 1 ? (kindNames[0] as DbFieldRule['type']) : 'any',
				required: seenIn[key] === docs.length
			};
		}
		return Object.keys(fields).length ? { fields, additionalFields: 'allow' } : null;
	}

	async function openRules(name: string) {
		const summary = agentState.collections.find((collection) => collection.name === name);
		rulesError = null;
		rulesFor = name;
		if (summary?.validator) {
			rulesJson = JSON.stringify(summary.validator, null, 2);
			return;
		}
		// No rules yet: propose a starting point from the live documents.
		rulesJson = RULES_TEMPLATE;
		try {
			const response = await fetch(`/api/projects/${data.projectId}/db/admin/query`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ collection: name, query: { limit: 20 } })
			});
			const result = (await response.json().catch(() => null)) as DbQueryResult | null;
			if (rulesFor !== name || !response.ok || !result?.docs.length) return;
			const inferred = inferValidator(result.docs);
			if (inferred) rulesJson = JSON.stringify(inferred, null, 2);
		} catch {
			// keep the generic template
		}
	}

	async function saveRules(clear: boolean) {
		const name = rulesFor;
		if (!name) return;
		let validator: DbValidator | null = null;
		if (!clear) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(rulesJson);
			} catch (error) {
				rulesError = `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
				return;
			}
			const checked = dbValidatorSchema.safeParse(parsed);
			if (!checked.success) {
				rulesError = checked.error.issues
					.map((issue) => `${issue.path.join('.') || 'validator'}: ${issue.message}`)
					.join('; ');
				return;
			}
			validator = checked.data;
		}
		busy = true;
		const current = currentAccess(name);
		const message = await saveCollectionConfig(name, {
			readAccess: current.readAccess,
			writeAccess: current.writeAccess,
			validator
		});
		busy = false;
		if (message) {
			rulesError = message;
			return;
		}
		rulesFor = null;
	}

	// Export / import: operator surfaces over the admin proxy.
	const adminBase = $derived(`/api/projects/${data.projectId}/db/admin/collections`);
	let importBusy = $state(false);
	let importReport = $state<DbImportReport | null>(null);
	let importError = $state<string | null>(null);
	let importInput = $state<HTMLInputElement | null>(null);

	async function importFile(event: Event) {
		const collection = selected;
		const file = (event.target as HTMLInputElement).files?.[0];
		if (!collection || !file) return;
		importBusy = true;
		importError = null;
		importReport = null;
		try {
			const response = await fetch(`${adminBase}/${encodeURIComponent(collection)}/import`, {
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
			await refreshData(data.projectId);
		} catch (error) {
			importError = error instanceof Error ? error.message : String(error);
		} finally {
			importBusy = false;
			if (importInput) importInput.value = '';
		}
	}

	// Point-in-time rollback, mimicking Cloudflare D1's restore flow: a
	// Date | Bookmark toggle where a picked time resolves to the CLOSEST
	// AVAILABLE BOOKMARK before anything is restored, plus captured named
	// points (checkpoints, before-import, before-rollback) as one-click
	// fills. Local development has no durable change log; the dialog says so
	// up front instead of failing after a submit.
	let rollbackOpen = $state(false);
	let rollbackInfo = $state<DbRestorePoints | null>(null);
	let rollbackMode = $state<'date' | 'bookmark'>('date');
	// Date and clock are separate fields (Firefox has no datetime-local
	// picker); they combine into one local Date at resolve time.
	let rollbackDate = $state('');
	let rollbackClock = $state('');
	let rollbackBookmarkInput = $state('');
	let resolvedBookmark = $state<string | null>(null);
	let resolveBusy = $state(false);
	let resolveError = $state<string | null>(null);
	let rollbackConfirmInput = $state('');
	let rollbackError = $state<string | null>(null);
	let rollbackUndo = $state<string | null>(null);
	/** The most recent manual save, surfaced so the bookmark can be copied. */
	let lastCaptured = $state<DbRestorePoint | null>(null);
	let resolveTimer: ReturnType<typeof setTimeout> | null = null;

	/** What a submit would restore to, whichever tab is active. */
	const rollbackTarget = $derived(
		rollbackMode === 'date' ? resolvedBookmark : rollbackBookmarkInput.trim() || null
	);

	function openRollback() {
		rollbackInfo = null;
		rollbackMode = 'date';
		rollbackDate = '';
		rollbackClock = '';
		rollbackBookmarkInput = '';
		resolvedBookmark = null;
		resolveError = null;
		rollbackConfirmInput = '';
		rollbackError = null;
		rollbackUndo = null;
		lastCaptured = null;
		rollbackOpen = true;
		void refreshRestorePoints();
	}

	async function refreshRestorePoints() {
		const name = selected;
		if (!name) return;
		try {
			const response = await fetch(`${adminBase}/${encodeURIComponent(name)}/restore-points`);
			const result = (await response.json().catch(() => null)) as DbRestorePoints | null;
			rollbackInfo = response.ok && result ? result : { supported: false, points: [] };
		} catch {
			rollbackInfo = { supported: false, points: [] };
		}
	}

	/** Debounced D1-style resolution: time in, closest bookmark out. */
	function scheduleResolve(date: string, clock: string) {
		rollbackDate = date;
		rollbackClock = clock;
		resolvedBookmark = null;
		resolveError = null;
		if (resolveTimer) clearTimeout(resolveTimer);
		// A date alone resolves against midnight; the clock refines it.
		if (!date || !selected) return;
		resolveTimer = setTimeout(() => void resolveBookmark(), 350);
	}

	let datePickerOpen = $state(false);
	const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'long' });
	/** The picked day as the Calendar's DateValue, or undefined when unset. */
	const calendarValue = $derived(rollbackDate ? parseDate(rollbackDate) : undefined);

	/** The two fields as one local Date, or null when unusable. */
	function rollbackMoment(): Date | null {
		if (!rollbackDate) return null;
		const at = new Date(`${rollbackDate}T${rollbackClock || '00:00:00'}`);
		return Number.isNaN(at.getTime()) ? null : at;
	}

	async function resolveBookmark() {
		const name = selected;
		const at = rollbackMoment();
		if (!name || !at) return;
		if (at.getTime() > Date.now()) {
			resolveError = 'Pick a moment in the past.';
			return;
		}
		resolveBusy = true;
		try {
			const response = await fetch(
				`${adminBase}/${encodeURIComponent(name)}/bookmark?at=${encodeURIComponent(at.toISOString())}`
			);
			const result = (await response.json().catch(() => null)) as {
				bookmark?: string;
				error?: string;
			} | null;
			if (!response.ok || !result?.bookmark) {
				throw new Error(result?.error ?? `request failed (HTTP ${response.status})`);
			}
			resolvedBookmark = result.bookmark;
			resolveError = null;
		} catch (error) {
			resolveError = error instanceof Error ? error.message : String(error);
		} finally {
			resolveBusy = false;
		}
	}

	/** Bookmark this exact moment so it can be rolled back to later. */
	async function capturePoint() {
		const name = selected;
		if (!name) return;
		busy = true;
		rollbackError = null;
		try {
			const response = await fetch(`${adminBase}/${encodeURIComponent(name)}/checkpoint`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ reason: 'saved by operator' })
			});
			const result = (await response.json().catch(() => null)) as
				(DbRestorePoint & { error?: string }) | null;
			if (!response.ok || !result?.bookmark) {
				throw new Error(result?.error ?? `request failed (HTTP ${response.status})`);
			}
			lastCaptured = result;
			await refreshRestorePoints();
		} catch (error) {
			rollbackError = error instanceof Error ? error.message : String(error);
		} finally {
			busy = false;
		}
	}

	async function rollback(body: { bookmark: string }) {
		const name = selected;
		if (!name) return;
		busy = true;
		rollbackError = null;
		try {
			const response = await fetch(`${adminBase}/${encodeURIComponent(name)}/restore`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			const result = (await response.json().catch(() => null)) as {
				restored?: boolean;
				undoBookmark?: string;
				error?: string;
			} | null;
			if (!response.ok || !result?.restored) {
				throw new Error(result?.error ?? `request failed (HTTP ${response.status})`);
			}
			rollbackUndo = result.undoBookmark ?? null;
			rollbackConfirmInput = '';
			await refreshData(data.projectId);
			// The undo bookmark is persisted server-side as "before rollback".
			await refreshRestorePoints();
		} catch (error) {
			rollbackError = error instanceof Error ? error.message : String(error);
		} finally {
			busy = false;
		}
	}

	// Inline document editor (PUT replaces an existing id, so it doubles as edit).
	let editorOpen = $state(false);
	let docIdInput = $state('');
	let docJsonInput = $state('{ "title": "Ship it", "done": false }');
	let docError = $state<string | null>(null);

	// Collection deletion is destructive enough that confirm() is not enough:
	// the collection name must be typed back before the button arms.
	let deletePanelOpen = $state(false);
	let deleteConfirmInput = $state('');
	let deleteError = $state<string | null>(null);

	async function deleteCollection() {
		const name = selected;
		if (!name || deleteConfirmInput.trim() !== name) return;
		busy = true;
		deleteError = null;
		try {
			const response = await fetch(
				`/api/projects/${data.projectId}/db/admin/collections/${encodeURIComponent(name)}`,
				{ method: 'DELETE' }
			);
			if (!response.ok) {
				const result = (await response.json().catch(() => null)) as { error?: string } | null;
				throw new Error(result?.error ?? `request failed (HTTP ${response.status})`);
			}
			closeBrowser();
			await refreshData(data.projectId);
		} catch (error) {
			deleteError = error instanceof Error ? error.message : String(error);
		} finally {
			busy = false;
		}
	}

	/**
	 * Open the editor prefilled from a row. The id is locked in this mode:
	 * PUT is an upsert, so saving under a changed id would create a duplicate
	 * instead of renaming.
	 */
	let editingExisting = $state(false);
	function editDocument(doc: DbDocument) {
		docIdInput = doc.id;
		docJsonInput = JSON.stringify(doc.data, null, 2);
		docError = null;
		editingExisting = true;
		editorOpen = true;
	}

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
			const id = docIdInput.trim() || ulid();
			// ADD refuses a taken id (409) so a typo cannot silently overwrite;
			// EDIT keeps the deliberate replace semantics.
			const guard = editingExisting ? '' : '?ifAbsent=1';
			const response = await fetch(
				`/api/projects/${data.projectId}/db/admin/collections/${encodeURIComponent(collection)}/documents/${encodeURIComponent(id)}${guard}`,
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
		'collection.restored': History,
		'documents.changed': FileText,
		'documents.imported': Upload,
		'table.created': FolderPlus,
		'table.configured': ShieldCheck,
		'table.deleted': Trash2,
		'rows.changed': FileText
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
	// without a hydration flash. CodeExample shape feeds the shared
	// CodeExamples component (shiki highlighting + copy), same as the auth tab.
	const origin = $derived(page.url.origin);
	const dbBase = $derived(`${origin}/api/projects/${data.projectId}/db`);
	const snippets = $derived<CodeExample[]>([
		{
			id: 'rest',
			label: 'REST',
			lang: 'bash',
			code: `# A project JWT for the signed-in user (session cookie or bearer token)
curl ${origin}/api/projects/${data.projectId}/auth/token

# Create a document (owner comes from the token subject)
curl -X POST ${dbBase}/collections/posts/documents \\
  -H 'authorization: Bearer <token>' \\
  -H 'content-type: application/json' \\
  -d '{"data":{"title":"Show HN: I built a Firebase on Cloudflare","votes":1}}'`
		},
		{
			id: 'sdk',
			label: 'Client SDK',
			lang: 'typescript',
			code: `import { createDbClient } from '@cloudflarebase/db/client';

const db = createDbClient({
	baseUrl: '${dbBase}',
	getToken: async () => {
		const response = await fetch('${origin}/api/projects/${data.projectId}/auth/token');
		return (await response.json()).token;
	}
});

const posts = db.collection('posts');
await posts.create({ title: 'Show HN: I built a Firebase on Cloudflare', votes: 1 });

// Server-side aggregates and NDJSON export
const total = await posts.count();
const { votes } = await posts.aggregate({ aggregates: { votes: { op: 'sum', field: 'votes' } } });

// The front page re-ranks itself on every vote, on every open screen.
const unsubscribe = posts.subscribe(
	{ orderBy: [{ field: 'votes', direction: 'desc' }], limit: 25 },
	{
		onSnapshot: (docs) => render(docs),
		onChange: (change, docs) => render(docs)
	}
);`
		},
		{
			id: 'ws',
			label: 'Raw WebSocket',
			lang: 'javascript',
			code: `const ws = new WebSocket(
	'${origin.replace(/^http/, 'ws')}/agents/db-agent/${data.projectId}/collections/posts/subscribe'
);
ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', id: 'q1', query: { limit: 50 } }));
ws.onmessage = (event) => console.log(JSON.parse(event.data));
// -> { type: 'snapshot', ... } once, then { type: 'change', kind: 'added' | 'modified' | 'removed', ... }`
		}
	]);
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
				Like Firestore, but every collection is its own Durable Object - JSON documents, queries,
				and onSnapshot-style live subscriptions.
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
			{#each [['collections', 'Collections'], ['tables', 'Tables'], ['access', 'Access'], ['replication', 'Replication'], ['setup', 'Integration']] as tab (tab[0])}
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
					onclick={() => setActiveTab(tab[0])}>{tab[1]}</button
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
										placeholder="collection name…"
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
								Up to 50 documents in id order, refetched on every change. Adding refuses an id that
								already exists; editing a row replaces it.
							</Card.Description>
							<!-- Desktop: labeled row beside the title; mobile drops the row
							     UNDER the header full-width with Add document stretched.
							     Export/import/delete live in the three-dots menu. -->
							<Card.Action
								class="flex flex-wrap items-center gap-2 self-center max-md:col-span-2 max-md:col-start-1 max-md:row-span-1 max-md:row-start-auto max-md:mt-2 max-md:w-full max-md:justify-self-stretch"
							>
								<Button
									size="sm"
									class="gap-1.5 max-md:flex-1"
									data-testid="db-add-document"
									aria-label="Add document"
									onclick={() => {
										editorOpen = !editorOpen;
										editingExisting = false;
										docIdInput = '';
										docError = null;
									}}
								>
									<Plus class="h-4 w-4" />Add document
								</Button>
								<input
									bind:this={importInput}
									type="file"
									accept=".ndjson,.jsonl,.txt,application/x-ndjson"
									class="hidden"
									onchange={importFile}
								/>
								<Button
									size="sm"
									variant="outline"
									class="gap-1.5"
									data-testid="db-rollback"
									aria-label="Roll back in time"
									onclick={openRollback}
								>
									<History class="h-4 w-4" /><span class="max-md:sr-only">Roll back</span>
								</Button>
								<DropdownMenu.Root>
									<DropdownMenu.Trigger>
										{#snippet child({ props })}
											<Button
												{...props}
												size="icon"
												variant="outline"
												class="h-8 w-8"
												aria-label="More collection actions"
												data-testid="db-actions-menu"
											>
												<EllipsisVertical class="h-4 w-4" />
											</Button>
										{/snippet}
									</DropdownMenu.Trigger>
									<DropdownMenu.Content align="end">
										<DropdownMenu.Item
											data-testid="db-export"
											onclick={() =>
												selected &&
												(window.location.href = `${adminBase}/${encodeURIComponent(selected)}/export`)}
										>
											<Download class="h-4 w-4" /> Export NDJSON
										</DropdownMenu.Item>
										<DropdownMenu.Item
											data-testid="db-import"
											disabled={importBusy}
											onclick={() => importInput?.click()}
										>
											<Upload class="h-4 w-4" />
											{importBusy ? 'Importing…' : 'Import NDJSON'}
										</DropdownMenu.Item>
										<DropdownMenu.Separator />
										<DropdownMenu.Item
											variant="destructive"
											data-testid="db-delete-collection"
											onclick={() => {
												deletePanelOpen = true;
												deleteConfirmInput = '';
												deleteError = null;
											}}
										>
											<Trash2 class="h-4 w-4" /> Delete
										</DropdownMenu.Item>
									</DropdownMenu.Content>
								</DropdownMenu.Root>
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
											<Label for="doc-id">
												{editingExisting
													? 'Document id (fixed while editing)'
													: 'Document id (optional)'}
											</Label>
											<!-- Locked during edit: PUT is an upsert, so a changed id would
											     CREATE a second document and leave the original behind. -->
											<Input
												id="doc-id"
												class="font-mono"
												placeholder="auto-generated"
												disabled={editingExisting}
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
							{#if importError}
								<p class="mb-3 text-sm text-destructive" data-testid="db-import-error">
									{importError}
								</p>
							{/if}
							{#if importReport}
								<p class="mb-3 text-sm text-muted-foreground" data-testid="db-import-result">
									Imported {importReport.imported} new and replaced {importReport.updated} documents{importReport
										.errors.length
										? `; ${importReport.errors.length} lines failed (first: line ${importReport.errors[0].line} - ${importReport.errors[0].error})`
										: '.'}
								</p>
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
														class="h-8 w-8 text-muted-foreground hover:text-foreground"
														disabled={busy}
														aria-label={`Edit document ${doc.id}`}
														data-testid={`db-edit-${doc.id}`}
														onclick={() => editDocument(doc)}
													>
														<Pencil class="h-4 w-4" />
													</Button>
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
		<!-- TABLES -->
		{#if activeTab === 'tables'}
			<TablesTab
				projectId={data.projectId}
				tables={agentState.tables ?? []}
				totalRows={agentState.totalRows ?? 0}
				{permissionOptions}
				refresh={() => refreshData(data.projectId)}
			/>
		{/if}

		{#if activeTab === 'replication'}
			<ReplicationTab
				projectId={data.projectId}
				collections={agentState.collections}
				tables={agentState.tables ?? []}
			/>
		{/if}

		{#if activeTab === 'access'}
			<div class="mt-4">
				<Card.Root data-testid="db-access-modes">
					<Card.Header>
						<Card.Title>Access modes</Card.Title>
						<Card.Description class="space-y-1.5">
							<span class="block">
								Every collection has one read rule and one write rule.
								<span class="font-mono text-foreground">public</span> = no sign-in needed ·
								<span class="font-mono text-foreground">auth</span> = any signed-in user of this
								project · <span class="font-mono text-foreground">owner</span> = signed-in, and every
								document remembers who created it, so users only reach their own.
							</span>
							<span class="block">
								A permission key tightens auth/owner further: the user's role must grant that key.
								Roles and their permissions live under Auth &gt; Roles; the built-in admin role
								grants everything. Each row below explains itself in plain words as you change it.
							</span>
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
							<Table.Root class="min-w-[60rem]">
								<Table.Header>
									<Table.Row>
										<Table.Head>Collection</Table.Head>
										<Table.Head>Read</Table.Head>
										<Table.Head>Write</Table.Head>
										<Table.Head>Read permission</Table.Head>
										<Table.Head>Write permission</Table.Head>
										<Table.Head>Rules</Table.Head>
										<Table.Head>Replication</Table.Head>
										<Table.Head class="w-40 text-right">
											<span class="sr-only">Actions</span>
										</Table.Head>
									</Table.Row>
								</Table.Header>
								<Table.Body>
									{#each agentState.collections as collection (collection.name)}
										{@const feedback = accessFeedback[collection.name]}
										{@const pending = currentAccess(collection.name)}
										<Table.Row data-testid={`db-access-${collection.name}`}>
											<Table.Cell class="font-mono text-sm font-medium">
												{collection.name}
											</Table.Cell>
											<Table.Cell>
												<Select.Root
													type="single"
													value={pending.readAccess}
													onValueChange={(value) =>
														setAccessField(collection.name, 'readAccess', toAccessMode(value))}
												>
													<Select.Trigger
														class="min-w-24 font-mono"
														size="sm"
														disabled={busy}
														aria-label={`Read access for ${collection.name}`}
													>
														{pending.readAccess}
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
													value={pending.writeAccess}
													onValueChange={(value) =>
														setAccessField(collection.name, 'writeAccess', toAccessMode(value))}
												>
													<Select.Trigger
														class="min-w-24 font-mono"
														size="sm"
														disabled={busy}
														aria-label={`Write access for ${collection.name}`}
													>
														{pending.writeAccess}
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
													value={pending.readPermission || NO_PERMISSION}
													onValueChange={(value) =>
														setAccessField(
															collection.name,
															'readPermission',
															value === NO_PERMISSION ? '' : value
														)}
												>
													<Select.Trigger
														class="min-w-32 font-mono"
														size="sm"
														disabled={busy || pending.readAccess === 'public'}
														aria-label={`Read permission for ${collection.name}`}
														data-testid={`db-perm-read-${collection.name}`}
													>
														{pending.readPermission || 'none'}
													</Select.Trigger>
													<Select.Content>
														<Select.Item value={NO_PERMISSION} label="none" class="font-mono" />
														{#each permissionOptions(pending.readPermission) as key (key)}
															<Select.Item value={key} label={key} class="font-mono" />
														{/each}
													</Select.Content>
												</Select.Root>
											</Table.Cell>
											<Table.Cell>
												<Select.Root
													type="single"
													value={pending.writePermission || NO_PERMISSION}
													onValueChange={(value) =>
														setAccessField(
															collection.name,
															'writePermission',
															value === NO_PERMISSION ? '' : value
														)}
												>
													<Select.Trigger
														class="min-w-32 font-mono"
														size="sm"
														disabled={busy || pending.writeAccess === 'public'}
														aria-label={`Write permission for ${collection.name}`}
														data-testid={`db-perm-write-${collection.name}`}
													>
														{pending.writePermission || 'none'}
													</Select.Trigger>
													<Select.Content>
														<Select.Item value={NO_PERMISSION} label="none" class="font-mono" />
														{#each permissionOptions(pending.writePermission) as key (key)}
															<Select.Item value={key} label={key} class="font-mono" />
														{/each}
													</Select.Content>
												</Select.Root>
											</Table.Cell>
											<Table.Cell>
												{@const ruleCount = Object.keys(collection.validator?.fields ?? {}).length}
												<Button
													size="sm"
													variant={collection.validator ? 'secondary' : 'ghost'}
													class="font-mono text-xs"
													disabled={busy}
													data-testid={`db-rules-${collection.name}`}
													onclick={() => void openRules(collection.name)}
												>
													{collection.validator
														? `${ruleCount} ${ruleCount === 1 ? 'rule' : 'rules'}`
														: 'none'}
												</Button>
											</Table.Cell>
											<Table.Cell>
												<Select.Root
													type="single"
													value={pending.replication}
													onValueChange={(value) =>
														setAccessField(
															collection.name,
															'replication',
															value === 'off' ? 'off' : 'auto'
														)}
												>
													<Select.Trigger
														class="min-w-24 font-mono"
														size="sm"
														disabled={busy}
														aria-label={`Replication for ${collection.name}`}
														data-testid={`db-replication-${collection.name}`}
													>
														{pending.replication}
													</Select.Trigger>
													<Select.Content>
														<Select.Item value="auto" label="auto" class="font-mono" />
														<Select.Item value="off" label="off" class="font-mono" />
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
										<!-- The row restated as a sentence, live-updated with pending
										     edits BEFORE Apply - the tab's teaching device. -->
										<Table.Row class="border-b hover:bg-transparent">
											<Table.Cell
												colspan={8}
												class="pt-2 pb-3 text-xs whitespace-normal text-muted-foreground"
												data-testid={`db-access-summary-${collection.name}`}
											>
												<span class="font-semibold text-destructive" aria-hidden="true">*</span>
												{accessSentence(pending, Boolean(collection.validator))}
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
						<!-- Same component as the auth Integration tab: shiki highlighting,
						     tab pills, and the built-in copy button. -->
						<CodeExamples examples={snippets} />
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

<!-- Collection deletion: destructive enough that the name must be typed back. -->
<Dialog.Root bind:open={deletePanelOpen}>
	<Dialog.Content data-testid="db-delete-panel">
		<Dialog.Header>
			<Dialog.Title>Delete {selected}?</Dialog.Title>
			<Dialog.Description>
				This permanently deletes <span class="font-mono font-semibold">{selected}</span> and every document
				in it - the collection's whole Durable Object is erased. Type the collection name to confirm.
			</Dialog.Description>
		</Dialog.Header>
		<Input
			class="font-mono"
			placeholder={selected}
			data-testid="db-delete-confirm"
			bind:value={deleteConfirmInput}
		/>
		{#if deleteError}
			<p class="text-sm text-destructive">{deleteError}</p>
		{/if}
		<Dialog.Footer>
			<Button
				variant="ghost"
				onclick={() => {
					deletePanelOpen = false;
					deleteConfirmInput = '';
					deleteError = null;
				}}
			>
				Cancel
			</Button>
			<Button
				variant="destructive"
				disabled={busy || !selected || deleteConfirmInput.trim() !== selected}
				onclick={deleteCollection}
			>
				Delete forever
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<!-- Rules-lite validator editor: the JSON shape the agent enforces on public writes. -->
<Dialog.Root open={rulesFor !== null} onOpenChange={(open) => !open && (rulesFor = null)}>
	<Dialog.Content class="sm:max-w-xl" data-testid="db-rules-panel">
		<Dialog.Header>
			<Dialog.Title>Document rules for {rulesFor}</Dialog.Title>
			<Dialog.Description>
				What documents written through the public API must look like - seeded from the shape of the
				documents already in this collection, so edit from there. Per top-level field: type,
				required, maxLength (strings/arrays), min/max (numbers), enum (allowed values); set
				additionalFields to "reject" to refuse undeclared keys. The dashboard editor and imports
				bypass these rules.
			</Dialog.Description>
		</Dialog.Header>
		<Textarea
			class="min-h-56 font-mono text-xs"
			data-testid="db-rules-json"
			bind:value={rulesJson}
		/>
		{#if rulesError}
			<p class="text-sm text-destructive" data-testid="db-rules-error">{rulesError}</p>
		{/if}
		<Dialog.Footer>
			<Button variant="ghost" onclick={() => (rulesFor = null)}>Cancel</Button>
			<Button variant="outline" disabled={busy} onclick={() => saveRules(true)}>Clear rules</Button>
			<Button disabled={busy} data-testid="db-rules-save" onclick={() => saveRules(false)}>
				Save rules
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<!-- Point-in-time rollback, D1-restore-style: Date resolves to the closest
     available bookmark before anything is committed; Bookmark takes one
     directly, with captured points as one-click fills. -->
<Dialog.Root bind:open={rollbackOpen}>
	<Dialog.Content class="sm:max-w-lg" data-testid="db-rollback-panel">
		<Dialog.Header>
			<Dialog.Title>Roll back {selected}?</Dialog.Title>
			<Dialog.Description>
				Restores <span class="font-mono font-semibold">{selected}</span> to an earlier moment - any point
				in the past 30 days.
			</Dialog.Description>
		</Dialog.Header>
		{#if rollbackInfo && !rollbackInfo.supported}
			<p
				class="rounded-lg border border-dashed p-3 text-sm text-muted-foreground"
				data-testid="db-rollback-unsupported"
			>
				Point-in-time recovery is not available in this environment - local development keeps no
				durable change log. On a deployed stack every collection can roll back to any moment in the
				past 30 days.
			</p>
		{:else}
			<div class="space-y-3">
				<!-- Saving the current state is useful in BOTH modes (and before
				     anything risky), so it sits above the Date|Bookmark toggle
				     rather than inside one tab. -->
				<div
					class="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/20 p-3"
				>
					<div class="min-w-0">
						<p class="text-sm font-medium">Save this moment</p>
						<p class="text-xs text-muted-foreground">
							Bookmark the collection as it is right now, so you can roll back to it later.
						</p>
					</div>
					<Button
						size="sm"
						variant="outline"
						class="gap-1.5"
						data-testid="db-capture-point"
						disabled={busy}
						onclick={() => void capturePoint()}
					>
						<BookmarkPlus class="h-4 w-4" /> Save bookmark
					</Button>
					{#if lastCaptured}
						<code
							class="block w-full overflow-x-auto rounded border bg-muted/50 p-2 text-xs"
							data-testid="db-captured-bookmark">{lastCaptured.bookmark}</code
						>
					{/if}
				</div>
				<div class="flex w-fit gap-1 rounded-lg border p-1" role="tablist">
					<Button
						size="sm"
						variant={rollbackMode === 'date' ? 'secondary' : 'ghost'}
						data-testid="db-rollback-mode-date"
						onclick={() => (rollbackMode = 'date')}
					>
						Date
					</Button>
					<Button
						size="sm"
						variant={rollbackMode === 'bookmark' ? 'secondary' : 'ghost'}
						data-testid="db-rollback-mode-bookmark"
						onclick={() => (rollbackMode = 'bookmark')}
					>
						Bookmark
					</Button>
				</div>

				{#if rollbackMode === 'date'}
					<div class="space-y-2">
						<Label for="rollback-date">Select a date and time</Label>
						<!-- shadcn date-picker (Popover + Calendar) rather than a bare
						     datetime-local: Firefox renders no picker for that type, so
						     the field degrades to a text box. The clock stays a native
						     time input, which every browser does support. -->
						<div class="flex gap-2">
							<Popover.Root bind:open={datePickerOpen}>
								<Popover.Trigger id="rollback-date" data-testid="db-rollback-date">
									{#snippet child({ props })}
										<Button
											{...props}
											variant="outline"
											class={[
												'flex-1 justify-start text-left font-normal',
												!rollbackDate && 'text-muted-foreground'
											]}
										>
											<CalendarIcon class="mr-2 h-4 w-4" />
											{rollbackDate
												? dateFormatter.format(new Date(`${rollbackDate}T00:00:00`))
												: 'Pick a date'}
										</Button>
									{/snippet}
								</Popover.Trigger>
								<Popover.Content class="w-auto p-0">
									<Calendar
										type="single"
										value={calendarValue}
										maxValue={today(getLocalTimeZone())}
										onValueChange={(value) => {
											datePickerOpen = false;
											scheduleResolve(value ? value.toString() : '', rollbackClock);
										}}
									/>
								</Popover.Content>
							</Popover.Root>
							<Input
								id="rollback-clock"
								type="time"
								step="1"
								class="w-36"
								data-testid="db-rollback-time"
								value={rollbackClock}
								oninput={(event) => scheduleResolve(rollbackDate, event.currentTarget.value)}
							/>
						</div>
					</div>
					<div class="space-y-2">
						<Label>Closest available bookmark</Label>
						{#if resolveBusy}
							<p class="text-xs text-muted-foreground">Resolving…</p>
						{:else if resolveError}
							<p class="text-xs text-destructive" data-testid="db-resolve-error">{resolveError}</p>
						{:else if resolvedBookmark}
							<code
								class="block overflow-x-auto rounded border bg-muted/50 p-2 text-xs"
								data-testid="db-resolved-bookmark"
							>
								{resolvedBookmark}
							</code>
						{:else}
							<p class="text-xs text-muted-foreground">Pick a time above to resolve one.</p>
						{/if}
					</div>
				{:else}
					<div class="space-y-2">
						<Label for="rollback-bookmark">Bookmark</Label>
						<Input
							id="rollback-bookmark"
							class="font-mono text-xs"
							placeholder="0000ba73-00000006-…"
							data-testid="db-rollback-bookmark"
							bind:value={rollbackBookmarkInput}
						/>
					</div>
					<div class="space-y-2">
						<Label>Captured points</Label>
						{#if rollbackInfo === null}
							<p class="text-xs text-muted-foreground">Loading captured points…</p>
						{:else if rollbackInfo.points.length === 0}
							<p class="text-xs text-muted-foreground">
								None yet - imports and rollbacks capture one automatically.
							</p>
						{:else}
							<div class="max-h-36 space-y-1 overflow-y-auto rounded-lg border p-1">
								{#each rollbackInfo.points as point, index (point.bookmark + point.capturedAt)}
									<button
										type="button"
										class={[
											'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted',
											rollbackBookmarkInput === point.bookmark && 'bg-muted'
										]}
										data-testid={`db-restore-point-${index}`}
										onclick={() => (rollbackBookmarkInput = point.bookmark)}
									>
										<span>{point.reason}</span>
										<span class="shrink-0 text-muted-foreground">{timeAgo(point.capturedAt)}</span>
									</button>
								{/each}
							</div>
						{/if}
					</div>
				{/if}

				<div class="space-y-2">
					<Label for="rollback-confirm">Type the collection name to confirm</Label>
					<Input
						id="rollback-confirm"
						class="font-mono"
						placeholder={selected}
						data-testid="db-rollback-confirm"
						bind:value={rollbackConfirmInput}
					/>
				</div>
				<p class="text-xs text-muted-foreground">
					Restoring overwrites the collection's current contents; live subscribers reconnect against
					the restored data. Every restore returns an undo bookmark.
				</p>
			</div>
		{/if}
		{#if rollbackError}
			<p class="text-sm text-destructive" data-testid="db-rollback-error">{rollbackError}</p>
		{/if}
		{#if rollbackUndo}
			<div class="space-y-2 rounded-lg border bg-muted/20 p-3" data-testid="db-rollback-done">
				<p class="text-sm">Rolled back. To reverse it, restore to this bookmark:</p>
				<code class="block overflow-x-auto rounded border bg-muted/50 p-2 text-xs">
					{rollbackUndo}
				</code>
				<Button
					size="sm"
					variant="outline"
					disabled={busy}
					onclick={() => rollbackUndo && void rollback({ bookmark: rollbackUndo })}
				>
					Undo the rollback
				</Button>
			</div>
		{/if}
		<Dialog.Footer>
			<Button variant="ghost" onclick={() => (rollbackOpen = false)}>
				{rollbackUndo ? 'Close' : 'Cancel'}
			</Button>
			<Button
				variant="destructive"
				data-testid="db-rollback-submit"
				disabled={busy ||
					!selected ||
					!rollbackInfo?.supported ||
					!rollbackTarget ||
					rollbackConfirmInput.trim() !== selected}
				onclick={() => rollbackTarget && void rollback({ bookmark: rollbackTarget })}
			>
				Roll back
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
