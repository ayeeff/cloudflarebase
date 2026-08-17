<script lang="ts">
	import { page } from '$app/state';
	import type {
		StorageBucketSummary,
		StorageObjectInfo,
		StorageObjectPage,
		StorageOverview
	} from '$lib/agents';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Sheet from '$lib/components/ui/sheet';
	import {
		ChevronRight,
		Download,
		FileText,
		FolderOpen,
		HardDrive,
		Image as ImageIcon,
		Link2,
		Plus,
		Trash2,
		Upload
	} from '@lucide/svelte';

	let { data } = $props();

	const tool = $derived(page.params.tool ?? 'files');
	const projectId = $derived(data.projectId);

	// The agent's own overview drives every degraded state, so the page is
	// honest about an install that cannot store bytes rather than failing at
	// the first upload.
	const overview = $derived<StorageOverview>(data.overview);

	const buckets = $derived(overview.buckets);
	let selected = $state<string | null>(null);
	const activeBucket = $derived<StorageBucketSummary | null>(
		buckets.find((bucket) => bucket.name === selected) ?? buckets[0] ?? null
	);

	// Folder navigation is a prefix, nothing more: folders are virtual, derived
	// at read time from the flat keys, so "entering" one is a string change.
	let prefix = $state('');
	const segments = $derived(prefix.split('/').filter(Boolean));

	type Folder = { prefix: string; objectCount: number };
	type UploadSession = { uploadId: string; partSize: number; parts: number };
	let objects = $state<StorageObjectInfo[]>([]);
	let folders = $state<Folder[]>([]);
	let total = $state(0);
	let cursor = $state<string | null>(null);
	let cursorStack = $state<string[]>([]);
	let loading = $state(false);
	let listError = $state('');

	/** `Response.json()` is `unknown`; every read of one is typed at the
	 * boundary rather than cast at each use. */
	async function errorOf(response: Response, fallback: string): Promise<string> {
		const body = (await response.json().catch(() => null)) as { error?: string } | null;
		return body?.error ?? fallback;
	}

	const agentBase = $derived(`/agents/storage-agent/${projectId}/admin/buckets`);

	async function loadObjects(nextCursor: string | null = null) {
		if (!activeBucket) return;
		loading = true;
		listError = '';
		try {
			// Built in one shot rather than mutated: this is a throwaway local,
			// not reactive state, and never calling a setter keeps it out of the
			// SvelteURLSearchParams rule that exists for the reactive case.
			const query = new URLSearchParams({
				delimiter: '/',
				limit: '50',
				...(prefix ? { prefix } : {}),
				...(nextCursor ? { cursor: nextCursor } : {})
			});
			const response = await fetch(
				`${agentBase}/${encodeURIComponent(activeBucket.name)}/objects?${query}`
			);
			if (!response.ok) {
				listError = await errorOf(response, 'could not list this bucket');
				return;
			}
			const body = (await response.json()) as StorageObjectPage;
			objects = body.objects ?? [];
			folders = body.folders ?? [];
			total = body.total ?? 0;
			cursor = body.cursor ?? null;
		} catch {
			listError = 'could not reach the storage agent';
		} finally {
			loading = false;
		}
	}

	// Re-read whenever the bucket or the folder changes, and on the 5s poll -
	// the operator-list convention: the poll re-reads the CURRENT page so a
	// live refresh never yanks the operator back to the top.
	$effect(() => {
		void activeBucket?.name;
		void prefix;
		cursorStack = [];
		void loadObjects(null);
	});

	function enterFolder(next: string) {
		prefix = next;
	}
	function goToSegment(index: number) {
		prefix = index < 0 ? '' : `${segments.slice(0, index + 1).join('/')}/`;
	}

	function displayName(key: string): string {
		return key.slice(prefix.length);
	}
	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
		return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
	}

	// The console must not render inline what the byte path will not serve
	// inline - the serve-time allowlist, mirrored so the two cannot disagree.
	const INLINE = /^(image\/(png|jpe?g|gif|webp|avif|bmp|x-icon)|text\/plain|application\/pdf)$/i;
	function isImage(contentType: string): boolean {
		return /^image\//i.test(contentType) && INLINE.test(contentType);
	}

	let previewOf = $state<StorageObjectInfo | null>(null);
	let signedUrl = $state('');
	let signing = $state(false);

	function objectUrl(key: string): string {
		if (!activeBucket) return '';
		const encoded = key.split('/').map(encodeURIComponent).join('/');
		return `${agentBase}/${encodeURIComponent(activeBucket.name)}/objects/${encoded}`;
	}

	async function mintSignedUrl() {
		if (!activeBucket || !previewOf) return;
		signing = true;
		try {
			const response = await fetch(
				`/api/projects/${projectId}/storage/admin/buckets/${encodeURIComponent(activeBucket.name)}/signed-urls`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ key: previewOf.key, expiresIn: 3600 })
				}
			);
			if (response.ok) signedUrl = ((await response.json()) as { signedUrl: string }).signedUrl;
		} finally {
			signing = false;
		}
	}

	let deleteTarget = $state<StorageObjectInfo | null>(null);
	async function confirmDelete() {
		if (!deleteTarget) return;
		await fetch(objectUrl(deleteTarget.key), { method: 'DELETE' });
		deleteTarget = null;
		previewOf = null;
		await loadObjects(null);
	}

	// --- Upload. Rides the ADMIN mirror through the /agents/* passthrough:
	// streaming, guard-gated, modes bypassed - and escalates to the same
	// multipart protocol end-user SDKs get, so the console has no special path
	// that could diverge from what customers run. ---
	let uploading = $state(false);
	let uploadProgress = $state(0);
	let uploadError = $state('');
	const SINGLE_PUT_MAX = 100 * 1024 * 1024;

	async function uploadFiles(files: FileList | null) {
		if (!files?.length || !activeBucket) return;
		uploading = true;
		uploadError = '';
		try {
			for (const file of Array.from(files)) {
				const key = `${prefix}${file.name}`;
				uploadProgress = 0;
				if (file.size > SINGLE_PUT_MAX) {
					await uploadMultipart(key, file);
				} else {
					const response = await fetch(objectUrl(key), {
						method: 'PUT',
						headers: { 'content-type': file.type || 'application/octet-stream' },
						body: file
					});
					if (!response.ok) {
						uploadError = await errorOf(response, 'upload failed');
						return;
					}
				}
			}
			await loadObjects(null);
		} finally {
			uploading = false;
			uploadProgress = 0;
		}
	}

	async function uploadMultipart(key: string, file: File) {
		if (!activeBucket) return;
		const base = `/agents/storage-agent/${projectId}/admin/buckets/${encodeURIComponent(activeBucket.name)}/uploads`;
		const created = await fetch(base, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				key,
				size: file.size,
				contentType: file.type || 'application/octet-stream'
			})
		});
		if (!created.ok) {
			uploadError = await errorOf(created, 'upload could not start');
			return;
		}
		const session = (await created.json()) as UploadSession;
		const parts: { partNumber: number; etag: string }[] = [];
		for (let index = 0; index < session.parts; index += 1) {
			const start = index * session.partSize;
			const chunk = file.slice(start, Math.min(start + session.partSize, file.size));
			const response = await fetch(`${base}/${session.uploadId}/parts/${index + 1}`, {
				method: 'PUT',
				body: chunk
			});
			if (!response.ok) {
				uploadError = `part ${index + 1} failed`;
				await fetch(`${base}/${session.uploadId}`, { method: 'DELETE' });
				return;
			}
			parts.push((await response.json()) as { partNumber: number; etag: string });
			uploadProgress = Math.round(((index + 1) / session.parts) * 100);
		}
		const done = await fetch(`${base}/${session.uploadId}/complete`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ parts })
		});
		if (!done.ok) uploadError = 'upload could not complete';
	}

	let newBucketOpen = $state(false);
	let newBucketName = $state('');
	let bucketError = $state('');
	async function createBucket(event: SubmitEvent) {
		event.preventDefault();
		bucketError = '';
		const response = await fetch(
			`/api/projects/${projectId}/storage/admin/buckets/${encodeURIComponent(newBucketName)}`,
			{ method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' }
		);
		if (!response.ok) {
			bucketError = await errorOf(response, 'could not create that bucket');
			return;
		}
		newBucketOpen = false;
		newBucketName = '';
		location.reload();
	}
</script>

<svelte:head>
	<title>{projectId} · Storage · Cloudflarebase</title>
</svelte:head>

{#if !overview.configured}
	<div class="mx-auto max-w-3xl px-4 py-10">
		<Card.Root data-testid="storage-unconfigured">
			<Card.Header>
				<Card.Title class="flex items-center gap-2"
					><HardDrive class="h-5 w-5 text-primary" /> Storage needs an R2 bucket</Card.Title
				>
				<Card.Description>
					R2 is an account-level opt-in, so this install ships without the binding rather than
					failing every deploy for accounts that have not enabled it.
				</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-2 text-sm text-muted-foreground">
				<p>1. Enable R2 in the Cloudflare dashboard (there is a free tier).</p>
				<p>
					2. Add the <code class="font-mono text-xs">BUCKET</code> binding to
					<code class="font-mono text-xs">agents/storage/wrangler.jsonc</code>.
				</p>
				<p>3. Redeploy the storage agent.</p>
			</Card.Content>
		</Card.Root>
	</div>
{:else if overview.erasing}
	<div class="mx-auto max-w-3xl px-4 py-10">
		<Card.Root data-testid="storage-erasing">
			<Card.Header>
				<Card.Title>This project's storage is being erased</Card.Title>
				<Card.Description>
					Object paths answer 503 until the drain finishes, so the next tenant of this id can never
					read what was here.
				</Card.Description>
			</Card.Header>
		</Card.Root>
	</div>
{:else if tool === 'access'}
	<div class="mx-auto max-w-4xl space-y-4 px-4 py-6" data-testid="storage-access">
		<div>
			<h1 class="text-lg font-semibold">Access</h1>
			<p class="text-sm text-muted-foreground">
				Read and write modes are separate, and both default to <code class="font-mono text-xs"
					>auth</code
				> - a fresh bucket is never anonymous.
			</p>
		</div>
		{#each buckets as bucket (bucket.name)}
			<Card.Root data-testid="access-card-{bucket.name}">
				<Card.Header>
					<Card.Title class="text-base">{bucket.name}</Card.Title>
					<Card.Description>
						Anyone {bucket.read === 'public'
							? 'can read objects in this bucket'
							: bucket.read === 'auth'
								? 'with a signed-in project user can read objects'
								: 'can read only the objects they wrote'}, and {bucket.write === 'public'
							? 'anyone can write'
							: bucket.write === 'auth'
								? 'signed-in users can write'
								: 'each user can write only their own keys'}.
						{bucket.publicListing
							? ' Listing every key is public.'
							: ' Listing every key is not public.'}
					</Card.Description>
				</Card.Header>
				<Card.Content class="flex gap-6 text-sm">
					<div><span class="text-muted-foreground">read</span> <Badge>{bucket.read}</Badge></div>
					<div><span class="text-muted-foreground">write</span> <Badge>{bucket.write}</Badge></div>
					<div class="text-muted-foreground">
						{bucket.objectCount} objects · {formatBytes(bucket.totalBytes)}
					</div>
				</Card.Content>
			</Card.Root>
		{/each}
	</div>
{:else if tool === 'integration'}
	<div class="mx-auto max-w-3xl space-y-4 px-4 py-6" data-testid="storage-integration">
		<div>
			<h1 class="text-lg font-semibold">Integration</h1>
			<p class="text-sm text-muted-foreground">
				One call for every size - the client escalates to multipart above 100 MB by itself.
			</p>
		</div>
		<Card.Root>
			<Card.Content class="pt-6">
				<pre class="overflow-x-auto rounded-md bg-muted p-4 text-xs"><code
						>{`import { createStorageClient } from '@cloudflarebase/storage/client';

const storage = createStorageClient({
  baseUrl: '${page.url.origin}/agents/storage-agent/${projectId}',
  getToken: () => session.token
});

const files = storage.from('${activeBucket?.name ?? 'my-bucket'}');
await files.upload('avatars/me.png', file);
const { signedUrl } = await files.createSignedUrl('avatars/me.png', { expiresIn: 3600 });
const { objects, folders } = await files.list({ folders: true });`}</code
					></pre>
			</Card.Content>
		</Card.Root>
	</div>
{:else if !buckets.length}
	<div class="mx-auto max-w-2xl px-4 py-16 text-center" data-testid="storage-empty">
		<FolderOpen class="mx-auto h-10 w-10 text-muted-foreground" />
		<h1 class="mt-4 text-lg font-semibold">No buckets yet</h1>
		<p class="mt-1 text-sm text-muted-foreground">
			A bucket is a namespace for files. New buckets are private by default - read and write both
			require a signed-in project user.
		</p>
		<Button class="mt-4" onclick={() => (newBucketOpen = true)} data-testid="new-bucket">
			<Plus class="mr-1.5 h-4 w-4" /> New bucket
		</Button>
	</div>
{:else}
	<div class="flex h-full flex-col lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:grid-rows-1">
		<!-- Bucket rail -->
		<aside class="border-b lg:border-r lg:border-b-0" data-testid="bucket-rail">
			<div class="flex items-center justify-between px-3 py-2">
				<span class="text-[11px] font-medium tracking-wider text-muted-foreground uppercase"
					>Buckets</span
				>
				<Button
					size="icon"
					variant="ghost"
					class="h-6 w-6"
					onclick={() => (newBucketOpen = true)}
					data-testid="new-bucket"><Plus class="h-3.5 w-3.5" /></Button
				>
			</div>
			<div class="space-y-0.5 px-2 pb-2">
				{#each buckets as bucket (bucket.name)}
					<button
						type="button"
						class={[
							'w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors',
							activeBucket?.name === bucket.name ? 'bg-muted font-medium' : 'hover:bg-muted/60'
						]}
						data-testid="bucket-{bucket.name}"
						onclick={() => {
							selected = bucket.name;
							prefix = '';
						}}
					>
						<span class="block truncate">{bucket.name}</span>
						<span class="block text-xs text-muted-foreground">
							{bucket.objectCount} · {formatBytes(bucket.totalBytes)}
						</span>
					</button>
				{/each}
			</div>
		</aside>

		<!-- Browser -->
		<section class="flex min-w-0 flex-col" data-testid="file-browser">
			<div class="flex flex-wrap items-center gap-2 border-b px-4 py-2">
				<nav class="flex min-w-0 flex-1 items-center gap-1 text-sm" data-testid="breadcrumb">
					<button type="button" class="hover:underline" onclick={() => goToSegment(-1)}>
						{activeBucket?.name}
					</button>
					{#each segments as segment, index (index)}
						<ChevronRight class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
						<button
							type="button"
							class="truncate hover:underline"
							onclick={() => goToSegment(index)}
						>
							{segment}
						</button>
					{/each}
				</nav>
				<label class="cursor-pointer">
					<input
						type="file"
						multiple
						class="hidden"
						data-testid="upload-input"
						onchange={(event) => uploadFiles(event.currentTarget.files)}
					/>
					<span
						class="inline-flex items-center rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
					>
						<Upload class="mr-1.5 h-3.5 w-3.5" />
						{uploading ? `Uploading${uploadProgress ? ` ${uploadProgress}%` : ''}…` : 'Upload'}
					</span>
				</label>
			</div>

			{#if uploadError}
				<p class="px-4 py-2 text-sm text-destructive" data-testid="upload-error">{uploadError}</p>
			{/if}
			{#if listError}
				<p class="px-4 py-2 text-sm text-destructive" data-testid="list-error">{listError}</p>
			{/if}

			<div class="min-h-0 flex-1 overflow-auto">
				<table class="w-full text-sm">
					<thead class="sticky top-0 bg-background">
						<tr class="border-b text-left text-xs text-muted-foreground">
							<th class="px-4 py-2 font-medium">Name</th>
							<th class="px-4 py-2 font-medium">Size</th>
							<th class="px-4 py-2 font-medium">Type</th>
							<th class="px-4 py-2 font-medium">Updated</th>
						</tr>
					</thead>
					<tbody data-testid="file-rows">
						<!-- The whole ROW is the target, not just the name: the row is
						     what looks clickable, so it has to be what responds. Rows
						     carry the keyboard affordance themselves rather than
						     wrapping a button, which a <td> cannot contain without
						     breaking the row into two tab stops. -->
						{#each folders as folder (folder.prefix)}
							<tr
								class="cursor-pointer border-b hover:bg-muted/50 focus-visible:bg-muted"
								data-testid="folder-row"
								role="button"
								tabindex="0"
								onclick={() => enterFolder(folder.prefix)}
								onkeydown={(event) => {
									if (event.key === 'Enter' || event.key === ' ') {
										event.preventDefault();
										enterFolder(folder.prefix);
									}
								}}
							>
								<td class="px-4 py-2">
									<span class="flex items-center gap-2">
										<FolderOpen class="h-4 w-4 text-muted-foreground" />
										{displayName(folder.prefix)}
									</span>
								</td>
								<td class="px-4 py-2 text-muted-foreground">—</td>
								<td class="px-4 py-2 text-muted-foreground">{folder.objectCount} objects</td>
								<td class="px-4 py-2 text-muted-foreground">—</td>
							</tr>
						{/each}
						{#each objects as object (object.key)}
							<tr
								class="cursor-pointer border-b hover:bg-muted/50 focus-visible:bg-muted"
								data-testid="object-row"
								role="button"
								tabindex="0"
								onclick={() => {
									previewOf = object;
									signedUrl = '';
								}}
								onkeydown={(event) => {
									if (event.key === 'Enter' || event.key === ' ') {
										event.preventDefault();
										previewOf = object;
										signedUrl = '';
									}
								}}
							>
								<td class="px-4 py-2">
									<span class="flex items-center gap-2">
										{#if isImage(object.contentType)}
											<ImageIcon class="h-4 w-4 text-muted-foreground" />
										{:else}
											<FileText class="h-4 w-4 text-muted-foreground" />
										{/if}
										{displayName(object.key)}
									</span>
								</td>
								<td class="px-4 py-2 text-muted-foreground">{formatBytes(object.size)}</td>
								<td class="px-4 py-2 text-muted-foreground">{object.contentType}</td>
								<td class="px-4 py-2 text-muted-foreground">
									{new Date(object.updatedAt).toLocaleDateString()}
								</td>
							</tr>
						{/each}
						{#if !loading && !folders.length && !objects.length}
							<tr
								><td colspan="4" class="px-4 py-10 text-center text-muted-foreground"
									>This folder is empty.</td
								></tr
							>
						{/if}
					</tbody>
				</table>
			</div>

			<div
				class="flex items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground"
			>
				<span data-testid="object-range">
					{objects.length ? `1–${objects.length} of ${total}` : `0 of ${total}`}
				</span>
				<div class="flex gap-2">
					<Button
						size="sm"
						variant="outline"
						disabled={!cursorStack.length}
						onclick={() => {
							const stack = [...cursorStack];
							stack.pop();
							cursorStack = stack;
							void loadObjects(stack[stack.length - 1] ?? null);
						}}>Prev</Button
					>
					<Button
						size="sm"
						variant="outline"
						disabled={!cursor}
						onclick={() => {
							if (!cursor) return;
							cursorStack = [...cursorStack, cursor];
							void loadObjects(cursor);
						}}>Next</Button
					>
				</div>
			</div>
		</section>
	</div>
{/if}

<Sheet.Root open={!!previewOf} onOpenChange={(open) => !open && (previewOf = null)}>
	<Sheet.Content side="right" class="w-full sm:max-w-md" data-testid="object-sheet">
		{#if previewOf}
			<Sheet.Header>
				<Sheet.Title class="text-base break-all">{displayName(previewOf.key)}</Sheet.Title>
				<Sheet.Description class="font-mono text-xs break-all">{previewOf.key}</Sheet.Description>
			</Sheet.Header>
			<div class="space-y-4 overflow-y-auto px-4 pb-4">
				{#if isImage(previewOf.contentType)}
					<img
						src={objectUrl(previewOf.key)}
						alt={previewOf.key}
						class="max-h-64 w-full rounded-md border object-contain"
					/>
				{:else}
					<!-- The console does not render inline what the byte path serves
					     as an attachment - HTML and SVG above all. -->
					<Button href={objectUrl(previewOf.key)} variant="outline" class="w-full">
						<Download class="mr-1.5 h-4 w-4" /> Download
					</Button>
				{/if}

				<dl class="space-y-1.5 text-sm">
					<div class="flex justify-between gap-4">
						<dt class="text-muted-foreground">Size</dt>
						<dd>{formatBytes(previewOf.size)}</dd>
					</div>
					<div class="flex justify-between gap-4">
						<dt class="text-muted-foreground">Type</dt>
						<dd class="truncate">{previewOf.contentType}</dd>
					</div>
					<div class="flex justify-between gap-4">
						<dt class="text-muted-foreground">Owner</dt>
						<dd class="truncate">{previewOf.owner || '—'}</dd>
					</div>
					<div class="flex justify-between gap-4">
						<dt class="text-muted-foreground">Updated</dt>
						<dd>{new Date(previewOf.updatedAt).toLocaleString()}</dd>
					</div>
				</dl>

				<div class="space-y-2">
					<Button
						variant="outline"
						class="w-full"
						disabled={signing}
						onclick={mintSignedUrl}
						data-testid="sign-url"
					>
						<Link2 class="mr-1.5 h-4 w-4" />
						{signing ? 'Signing…' : 'Create signed URL (1 hour)'}
					</Button>
					{#if signedUrl}
						<code
							class="block rounded-md border bg-muted p-2 font-mono text-[11px] break-all select-all"
							data-testid="signed-url">{signedUrl}</code
						>
					{/if}
					<Button
						variant="outline"
						class="w-full text-destructive"
						onclick={() => (deleteTarget = previewOf)}
						data-testid="delete-object"
					>
						<Trash2 class="mr-1.5 h-4 w-4" /> Delete
					</Button>
				</div>
			</div>
		{/if}
	</Sheet.Content>
</Sheet.Root>

<AlertDialog.Root open={!!deleteTarget} onOpenChange={(open) => !open && (deleteTarget = null)}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete this object?</AlertDialog.Title>
			<AlertDialog.Description class="break-all">
				{deleteTarget?.key} is removed from R2 and from the index. This cannot be undone.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action onclick={confirmDelete} data-testid="confirm-delete">
				Delete
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<Dialog.Root bind:open={newBucketOpen}>
	<Dialog.Content>
		<form onsubmit={createBucket}>
			<Dialog.Header>
				<Dialog.Title>New bucket</Dialog.Title>
				<Dialog.Description>
					Both read and write will require a signed-in project user until you change them on the
					Access page - a new bucket is never anonymous.
				</Dialog.Description>
			</Dialog.Header>
			<div class="space-y-2 py-4">
				<Label for="bucket-name">Name</Label>
				<Input
					id="bucket-name"
					bind:value={newBucketName}
					placeholder="avatars"
					required
					data-testid="bucket-name-input"
				/>
				<p class="text-xs text-muted-foreground">2–63 lowercase letters, numbers, and dashes.</p>
				{#if bucketError}
					<p class="text-sm text-destructive" data-testid="bucket-error">{bucketError}</p>
				{/if}
			</div>
			<Dialog.Footer>
				<Button type="submit" data-testid="create-bucket">Create</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
