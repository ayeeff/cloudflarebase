<script lang="ts">
	import type { DbRestorePoint, DbRestorePoints } from '$lib/agents';
	import { Button } from '$lib/components/ui/button';
	import { Calendar } from '$lib/components/ui/calendar';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Popover from '$lib/components/ui/popover';
	import { getLocalTimeZone, parseDate, today } from '@internationalized/date';
	import { BookmarkPlus, Calendar as CalendarIcon } from '@lucide/svelte';

	/**
	 * Point-in-time rollback, mimicking Cloudflare D1's restore flow: a
	 * Date | Bookmark toggle where a picked time resolves to the CLOSEST
	 * AVAILABLE BOOKMARK before anything is restored, plus captured named
	 * points (checkpoints, before-import, before-rollback) as one-click
	 * fills. Local development has no durable change log; the dialog says so
	 * up front instead of failing after a submit.
	 *
	 * Shared by the Collections browser and the Tables workspace - `base` is
	 * the shard's own admin URL (`.../admin/collections/<name>` or
	 * `.../admin/tables/<name>`), so the component never knows the proxy
	 * layout. The testids are identical for both kinds on purpose: only one
	 * dialog is ever open, and the e2e contract stays one vocabulary.
	 */
	let {
		open = $bindable(false),
		base,
		shardName,
		noun,
		onRestored
	}: {
		open?: boolean;
		/** Admin URL of this shard, no trailing slash. */
		base: string;
		/** Typed back to arm the destructive submit. */
		shardName: string;
		/** Copy only: what the thing being restored is called. */
		noun: 'collection' | 'table';
		/** Refresh the caller's data after a successful restore. */
		onRestored: () => Promise<void>;
	} = $props();

	let busy = $state(false);
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

	// Opening resets the whole flow and fetches the shard's restore points.
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
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
			void refreshRestorePoints();
		}
		wasOpen = open;
	});

	async function refreshRestorePoints() {
		try {
			const response = await fetch(`${base}/restore-points`);
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
		if (!date) return;
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
		const at = rollbackMoment();
		if (!at) return;
		if (at.getTime() > Date.now()) {
			resolveError = 'Pick a moment in the past.';
			return;
		}
		resolveBusy = true;
		try {
			const response = await fetch(`${base}/bookmark?at=${encodeURIComponent(at.toISOString())}`);
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
		busy = true;
		rollbackError = null;
		try {
			const response = await fetch(`${base}/checkpoint`, {
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
		busy = true;
		rollbackError = null;
		try {
			const response = await fetch(`${base}/restore`, {
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
			await onRestored();
			// The undo bookmark is persisted server-side as "before rollback".
			await refreshRestorePoints();
		} catch (error) {
			rollbackError = error instanceof Error ? error.message : String(error);
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
</script>

<!-- Point-in-time rollback, D1-restore-style: Date resolves to the closest
     available bookmark before anything is committed; Bookmark takes one
     directly, with captured points as one-click fills. -->
<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg" data-testid="db-rollback-panel">
		<Dialog.Header>
			<Dialog.Title>Roll back {shardName}?</Dialog.Title>
			<Dialog.Description>
				Restores <span class="font-mono font-semibold">{shardName}</span> to an earlier moment - any point
				in the past 30 days.
			</Dialog.Description>
		</Dialog.Header>
		{#if rollbackInfo && !rollbackInfo.supported}
			<p
				class="rounded-lg border border-dashed p-3 text-sm text-muted-foreground"
				data-testid="db-rollback-unsupported"
			>
				Point-in-time recovery is not available in this environment - local development keeps no
				durable change log. On a deployed stack every {noun} can roll back to any moment in the past 30
				days.
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
							Bookmark the {noun} as it is right now, so you can roll back to it later.
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
					<Label for="rollback-confirm">Type the {noun} name to confirm</Label>
					<Input
						id="rollback-confirm"
						class="font-mono"
						placeholder={shardName}
						data-testid="db-rollback-confirm"
						bind:value={rollbackConfirmInput}
					/>
				</div>
				<p class="text-xs text-muted-foreground">
					Restoring overwrites the {noun}'s current contents; live subscribers reconnect against the
					restored data. Every restore returns an undo bookmark.
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
			<Button variant="ghost" onclick={() => (open = false)}>
				{rollbackUndo ? 'Close' : 'Cancel'}
			</Button>
			<Button
				variant="destructive"
				data-testid="db-rollback-submit"
				disabled={busy ||
					!rollbackInfo?.supported ||
					!rollbackTarget ||
					rollbackConfirmInput.trim() !== shardName}
				onclick={() => rollbackTarget && void rollback({ bookmark: rollbackTarget })}
			>
				Roll back
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
