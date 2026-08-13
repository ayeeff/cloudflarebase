<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import type {
		DeployTokenInfo,
		GithubConnectionInfo,
		HostingDeploy,
		HostingOverview
	} from '$lib/agents';
	import ConnectGithubDialog from './connect-github-dialog.svelte';
	import {
		DEPLOY_TOKEN_SECRET_NAME,
		deployWorkflowYaml,
		secretsUrl,
		WORKFLOW_FILENAME,
		workflowCreateUrl
	} from '$lib/hosting-workflow';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import {
		Check,
		Copy,
		ExternalLink,
		GitBranch,
		KeyRound,
		Rocket,
		Sparkles,
		Terminal
	} from '@lucide/svelte';

	let { data } = $props();

	// Writable derived: the SSR payload wins on navigation, the poll overwrites
	// between loads.
	let overview: HostingOverview | null = $derived(data.overview);

	// The 5s poll every tool page rides; rev moves on any deploy from any client.
	$effect(() => {
		const projectId = data.projectId;
		if (data.demo) return;
		const poll = setInterval(() => void refreshOverview(projectId), 5_000);
		return () => clearInterval(poll);
	});

	async function refreshOverview(projectId: string) {
		const response = await fetch(`/api/projects/${projectId}/hosting/overview`).catch(() => null);
		if (!response?.ok) return;
		const body = (await response.json().catch(() => null)) as HostingOverview | null;
		if (body) overview = body;
	}

	// --- Deploy history: keyset paging, range-of-total + Prev/Next, never
	// truncation. Prev walks a client-side stack of the cursors that STARTED
	// each page, so the poll-refreshed current page never yanks the operator
	// back to the top.
	const PAGE_SIZE = 10;
	let deploys = $state<HostingDeploy[]>([]);
	let deployTotal = $state(0);
	let nextCursor = $state<string | null>(null);
	let cursorStack = $state<string[]>([]);
	let pageStart = $state(0);

	async function loadDeploys(cursor: string | null) {
		const query = `limit=${PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
		const response = await fetch(`/api/projects/${data.projectId}/hosting/deploys?${query}`).catch(
			() => null
		);
		if (!response?.ok) return;
		const body = (await response.json().catch(() => null)) as {
			deploys: HostingDeploy[];
			total: number;
			cursor: string | null;
		} | null;
		if (!body) return;
		deploys = body.deploys;
		deployTotal = body.total;
		nextCursor = body.cursor;
	}

	$effect(() => {
		if (data.demo) return;
		void loadDeploys(null);
	});

	async function nextPage() {
		if (!nextCursor) return;
		cursorStack = [...cursorStack, nextCursor];
		pageStart += deploys.length;
		await loadDeploys(nextCursor);
	}
	async function prevPage() {
		if (!cursorStack.length) return;
		const stack = cursorStack.slice(0, -1);
		cursorStack = stack;
		pageStart = Math.max(0, pageStart - PAGE_SIZE);
		await loadDeploys(stack[stack.length - 1] ?? null);
	}

	// --- Deploy tokens (roots only).
	let mintOpen = $state(false);
	let mintName = $state('');
	let mintBusy = $state(false);
	let mintError = $state<string | null>(null);
	let minted = $state<{ name: string; token: string } | null>(null);

	async function mintToken(event: SubmitEvent) {
		event.preventDefault();
		mintBusy = true;
		mintError = null;
		try {
			const response = await fetch(`/api/projects/${data.projectId}/hosting/tokens`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: mintName.trim() })
			});
			const body = (await response.json().catch(() => null)) as {
				error?: string;
				name?: string;
				token?: string;
			} | null;
			if (!response.ok || !body?.token) {
				mintError = body?.error ?? 'Could not mint the token.';
				return;
			}
			minted = { name: body.name ?? mintName, token: body.token };
			mintName = '';
			await invalidateAll();
		} finally {
			mintBusy = false;
		}
	}

	let revokeTarget = $state<DeployTokenInfo | null>(null);
	let revokeBusy = $state(false);

	async function revokeToken() {
		if (!revokeTarget || revokeBusy) return;
		revokeBusy = true;
		try {
			await fetch(`/api/projects/${data.projectId}/hosting/tokens/${revokeTarget.id}`, {
				method: 'DELETE'
			});
			revokeTarget = null;
			await invalidateAll();
		} finally {
			revokeBusy = false;
		}
	}

	// --- GitHub App path: one connection per app, made on the ROOT project.
	// A connection covers the root and all its branches, like a deploy token.
	let connectOpen = $state(false);

	// Coming back from installing on GitHub, open the picker straight away:
	// the operator's intent was "connect a repository", and the install was
	// only a step inside it. Landing on a static page and making them click
	// Connect again is where the flow felt broken. The param is stripped so a
	// refresh (or a later Back) does not reopen it.
	let preferInstallation = $state<number | null>(null);
	$effect(() => {
		const returned = page.url.searchParams.get('installation');
		if (!returned) return;
		// Preselect the account they just installed on, not merely the first.
		preferInstallation = Number(returned) || null;
		connectOpen = true;
		void goto(resolve('/(app)/dashboard/[projectId]/hosting', { projectId: data.projectId }), {
			replaceState: true,
			noScroll: true,
			keepFocus: true
		});
	});
	let disconnectTarget = $state<GithubConnectionInfo | null>(null);
	let disconnectBusy = $state(false);
	const connection = $derived(data.github.connections[0] ?? null);

	async function disconnect() {
		if (!disconnectTarget || disconnectBusy) return;
		disconnectBusy = true;
		try {
			await fetch(
				`/api/projects/${data.projectId}/hosting/github/connections/${encodeURIComponent(disconnectTarget.appName)}`,
				{ method: 'DELETE' }
			);
			disconnectTarget = null;
			await invalidateAll();
		} finally {
			disconnectBusy = false;
		}
	}

	// --- Manual path, only when no GitHub App is configured (the self-hosted
	// default): mint a token and prefill the workflow file on GitHub.
	let repo = $state('');
	let githubBusy = $state(false);
	let githubError = $state<string | null>(null);
	let githubToken = $state<string | null>(null);
	const repoValid = $derived(/^[\w.-]+\/[\w.-]+$/.test(repo.trim()));

	async function connectGithub(event: SubmitEvent) {
		event.preventDefault();
		githubBusy = true;
		githubError = null;
		try {
			const response = await fetch(`/api/projects/${data.projectId}/hosting/tokens`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: `github:${repo.trim()}` })
			});
			const body = (await response.json().catch(() => null)) as {
				error?: string;
				token?: string;
			} | null;
			if (!response.ok || !body?.token) {
				githubError = body?.error ?? 'Could not mint the deploy token.';
				return;
			}
			githubToken = body.token;
			await invalidateAll();
		} finally {
			githubBusy = false;
		}
	}

	let copied = $state<string | null>(null);
	async function copy(label: string, value: string) {
		try {
			await navigator.clipboard.writeText(value);
			copied = label;
			setTimeout(() => (copied = null), 2000);
		} catch {
			copied = null;
		}
	}

	const timeAgo = (iso: string) => {
		const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
		if (seconds < 60) return 'just now';
		if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
		if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
		return `${Math.floor(seconds / 86400)}d ago`;
	};
	const kb = (bytes: number) =>
		bytes < 1024
			? `${bytes} B`
			: bytes < 1024 * 1024
				? `${Math.round(bytes / 1024)} KB`
				: `${(bytes / 1024 / 1024).toFixed(1)} MB`;
</script>

<svelte:head>
	<title>Hosting · {data.projectId} · Cloudflarebase</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div
	class="mx-auto max-w-7xl space-y-5 px-3 py-5 sm:space-y-6 sm:px-6 sm:py-8"
	data-testid="hosting-page"
>
	<div class="flex items-center gap-3">
		<Rocket class="h-6 w-6 text-muted-foreground" />
		<div>
			<h1 class="text-2xl font-semibold tracking-tight">Hosting</h1>
			<p class="text-sm text-muted-foreground">
				Apps and functions on Workers for Platforms - one deploy, served at your subdomain.
			</p>
		</div>
	</div>

	{#if data.demo}
		<!-- No demo hosting: anonymous code execution is an abuse machine. -->
		<Card.Root data-testid="hosting-demo-upsell">
			<Card.Header>
				<Card.Title class="flex items-center gap-2 text-base">
					<Sparkles class="h-4 w-4 text-primary" /> Hosting needs a real project
				</Card.Title>
				<Card.Description>
					Demo projects are throwaway and cannot deploy apps. Sign in and create a project - then
					<code class="font-mono text-xs">cloudflarebase init</code> connects a repository and every
					deploy ships to <code class="font-mono text-xs">&lt;app&gt;.cfbase.dev</code>.
				</Card.Description>
			</Card.Header>
		</Card.Root>
	{:else if overview}
		{#if !overview.configured}
			<Card.Root>
				<Card.Header>
					<Card.Title class="text-base">Hosting is not configured</Card.Title>
					<Card.Description>
						This install has no Workers for Platforms dispatch namespace. Deploys are refused with a
						503 until <code class="font-mono text-xs">DISPATCH</code>,
						<code class="font-mono text-xs">DISPATCH_NAMESPACE</code>,
						<code class="font-mono text-xs">CF_ACCOUNT_ID</code>, and
						<code class="font-mono text-xs">CF_HOSTING_API_TOKEN</code> are set on the hosting worker.
					</Card.Description>
				</Card.Header>
			</Card.Root>
		{/if}

		<!-- Apps -->
		<Card.Root data-testid="hosting-apps">
			<Card.Header>
				<Card.Title class="text-base">Apps</Card.Title>
				<Card.Description>
					An app is one Worker in the dispatch namespace: static assets, server code, or both. The
					subdomain shown is what was actually claimed - taken names auto-number instead of failing.
				</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-3">
				{#if overview.apps.length === 0}
					<div class="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
						<p class="mb-2 flex items-center gap-2 font-medium text-foreground">
							<Terminal class="h-4 w-4" /> No apps yet
						</p>
						<p>
							In your app's repository:
							<code class="ml-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs"
								>npx @cloudflarebase/cli init</code
							>
							then
							<code class="ml-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs"
								>npx @cloudflarebase/cli deploy</code
							>
						</p>
					</div>
				{:else}
					<div class="grid gap-2">
						{#each overview.apps as app (app.name)}
							<div class="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3">
								<div class="min-w-0 flex-1">
									<p class="truncate text-sm font-medium">{app.name}</p>
									{#if app.url}
										<!-- eslint-disable svelte/no-navigation-without-resolve -- external app URL, not an in-app route -->
										<a
											href={app.url}
											target="_blank"
											rel="noreferrer"
											class="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
										>
											{app.url.replace('https://', '')}
											<ExternalLink class="h-3 w-3" />
										</a>
										<!-- eslint-enable svelte/no-navigation-without-resolve -->
									{:else}
										<p class="font-mono text-xs text-muted-foreground">{app.subdomain}</p>
									{/if}
								</div>
								<div class="shrink-0 text-right text-xs text-muted-foreground">
									<p>{app.deployCount} deploy{app.deployCount === 1 ? '' : 's'}</p>
									{#if app.lastDeployAt}
										<p>last {timeAgo(app.lastDeployAt)}</p>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</Card.Content>
		</Card.Root>

		<!-- Deploys -->
		<Card.Root data-testid="hosting-deploys">
			<Card.Header>
				<Card.Title class="text-base">Deploys</Card.Title>
			</Card.Header>
			<Card.Content class="space-y-3">
				{#if deploys.length === 0}
					<p class="text-sm text-muted-foreground">No deploys yet.</p>
				{:else}
					<div class="grid gap-2">
						{#each deploys as deploy (deploy.id)}
							<div class="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3">
								<Badge
									variant={deploy.status === 'live' ? 'default' : 'outline'}
									class="shrink-0 text-xs"
								>
									{deploy.status}
								</Badge>
								<div class="min-w-0 flex-1">
									<p class="truncate font-mono text-xs">{deploy.subdomain}</p>
									<p class="text-xs text-muted-foreground">
										{deploy.hasWorker ? 'worker + ' : ''}{deploy.assetCount} asset{deploy.assetCount ===
										1
											? ''
											: 's'} · {kb(deploy.assetBytes + deploy.moduleBytes)}
									</p>
								</div>
								<p class="shrink-0 text-xs text-muted-foreground">{timeAgo(deploy.createdAt)}</p>
							</div>
						{/each}
					</div>
					<div class="flex items-center justify-between text-xs text-muted-foreground">
						<span data-testid="hosting-deploys-range">
							{pageStart + 1}–{pageStart + deploys.length} of {deployTotal}
						</span>
						<div class="flex gap-2">
							<Button
								size="sm"
								variant="outline"
								disabled={cursorStack.length === 0}
								onclick={prevPage}
							>
								Prev
							</Button>
							<Button size="sm" variant="outline" disabled={!nextCursor} onclick={nextPage}>
								Next
							</Button>
						</div>
					</div>
				{/if}
			</Card.Content>
		</Card.Root>

		{#if data.isRoot}
			<!-- Deploy tokens -->
			<Card.Root data-testid="hosting-tokens">
				<Card.Header>
					<Card.Title class="flex items-center gap-2 text-base">
						<KeyRound class="h-4 w-4 text-muted-foreground" /> Deploy tokens
					</Card.Title>
					<Card.Description>
						CI's durable credential: valid only for deploys and branch creation on this project and
						its branches. Secrets are shown once and stored hashed - revoking deletes the hash.
					</Card.Description>
				</Card.Header>
				<Card.Content class="space-y-3">
					{#if data.tokens.length}
						<div class="grid gap-2" data-testid="hosting-token-list">
							{#each data.tokens as token (token.id)}
								<div class="flex items-center gap-3 rounded-lg border bg-card p-3">
									<div class="min-w-0 flex-1">
										<p class="truncate text-sm font-medium">{token.name}</p>
										<p class="text-xs text-muted-foreground">
											minted {timeAgo(token.createdAt)}{token.lastUsedAt
												? ` · last used ${timeAgo(token.lastUsedAt)}`
												: ' · never used'}
										</p>
									</div>
									<Button
										size="sm"
										variant="outline"
										onclick={() => (revokeTarget = token)}
										data-testid={`revoke-token-${token.name}`}
									>
										Revoke
									</Button>
								</div>
							{/each}
						</div>
					{:else}
						<p class="text-sm text-muted-foreground">No tokens minted.</p>
					{/if}
					<Button size="sm" onclick={() => (mintOpen = true)} data-testid="mint-token">
						Mint token
					</Button>
				</Card.Content>
			</Card.Root>

			<!-- Connect GitHub -->
			<Card.Root data-testid="hosting-github">
				<Card.Header>
					<Card.Title class="flex items-center gap-2 text-base">
						<GitBranch class="h-4 w-4 text-muted-foreground" /> Connect GitHub
					</Card.Title>
					<Card.Description>
						Push-to-deploy without a build farm. The default branch ships production; every other
						branch gets its own isolated preview at
						<code class="font-mono text-xs">&lt;app&gt;-&lt;branch&gt;</code>.
					</Card.Description>
				</Card.Header>
				<Card.Content class="space-y-4">
					{#if data.github.configured}
						{#if connection}
							<!-- Connected: what a push does, and how to stop it. -->
							<div class="space-y-3" data-testid="github-connection">
								<div class="flex flex-wrap items-center gap-2">
									<a
										class="font-mono text-sm underline-offset-4 hover:underline"
										href={`https://github.com/${connection.repoFullName}`}
										target="_blank"
										rel="noreferrer">{connection.repoFullName}</a
									>
									<Badge variant="secondary">
										{connection.mode === 'direct' ? 'No build step' : 'Builds on Actions'}
									</Badge>
									{#if connection.lastEventAt}
										<span class="text-xs text-muted-foreground">
											last push {timeAgo(connection.lastEventAt)}
										</span>
									{/if}
								</div>
								<p class="text-sm text-muted-foreground">
									{#if connection.mode === 'direct'}
										Every push to <code class="font-mono text-xs">{connection.defaultBranch}</code>
										publishes
										<code class="font-mono text-xs">{connection.assetsDir || 'the repo root'}</code>
										to <code class="font-mono text-xs">{connection.appName}</code> directly - no workflow
										file, no Actions minutes.
									{:else}
										Every push to <code class="font-mono text-xs">{connection.defaultBranch}</code>
										builds on GitHub's runners and deploys
										<code class="font-mono text-xs">{connection.appName}</code>. The repository
										holds no secret - deploys authenticate with GitHub's identity token.
									{/if}
								</p>
								<Button
									size="sm"
									variant="outline"
									onclick={() => (disconnectTarget = connection)}
									data-testid="disconnect-github"
								>
									Disconnect
								</Button>
							</div>
						{:else}
							<div class="space-y-3">
								<p class="text-sm text-muted-foreground">
									Connect a repository and every push deploys itself. A site with no build step
									needs no workflow file at all; one that builds gets a workflow that authenticates
									with GitHub's identity token instead of a stored secret.
								</p>
								<Button
									class="gap-2"
									onclick={() => (connectOpen = true)}
									data-testid="connect-github"
								>
									<GitBranch class="h-4 w-4" /> Connect repository
								</Button>
							</div>
						{/if}
					{:else if !githubToken}
						<form class="flex flex-wrap items-end gap-3" onsubmit={connectGithub}>
							<div class="min-w-56 flex-1 space-y-1.5">
								<Label for="github-repo">Repository</Label>
								<Input id="github-repo" bind:value={repo} placeholder="you/your-app" required />
							</div>
							<Button
								type="submit"
								disabled={!repoValid || githubBusy}
								data-testid="connect-github"
							>
								{githubBusy ? 'Minting…' : 'Generate setup'}
							</Button>
						</form>
						{#if githubError}
							<p class="text-sm text-destructive">{githubError}</p>
						{/if}
					{:else}
						<ol class="space-y-4 text-sm">
							<li class="space-y-2">
								<p class="font-medium">
									1. Add the deploy token as a repository secret named
									<code class="font-mono text-xs">{DEPLOY_TOKEN_SECRET_NAME}</code>
								</p>
								<div class="flex flex-wrap items-center gap-2">
									<code
										class="max-w-full truncate rounded bg-muted px-2 py-1 font-mono text-xs"
										data-testid="github-token-value">{githubToken}</code
									>
									<Button
										size="sm"
										variant="outline"
										class="gap-1.5"
										onclick={() => copy('token', githubToken!)}
									>
										{#if copied === 'token'}<Check class="h-3.5 w-3.5" />{:else}<Copy
												class="h-3.5 w-3.5"
											/>{/if} Copy
									</Button>
									<Button
										size="sm"
										variant="outline"
										class="gap-1.5"
										href={secretsUrl(repo.trim())}
										target="_blank"
										rel="noreferrer"
									>
										Open repo secrets <ExternalLink class="h-3.5 w-3.5" />
									</Button>
								</div>
								<p class="text-xs text-muted-foreground">
									Shown once - it is stored hashed. Revoke it any time above.
								</p>
							</li>
							<li class="space-y-2">
								<p class="font-medium">
									2. Commit the workflow as
									<code class="font-mono text-xs">{WORKFLOW_FILENAME}</code>
								</p>
								<div class="flex flex-wrap items-center gap-2">
									<Button
										size="sm"
										class="gap-1.5"
										href={workflowCreateUrl(repo.trim())}
										target="_blank"
										rel="noreferrer"
										data-testid="create-workflow-file"
									>
										Create the file on GitHub (pre-filled) <ExternalLink class="h-3.5 w-3.5" />
									</Button>
									<Button
										size="sm"
										variant="outline"
										class="gap-1.5"
										onclick={() => copy('yaml', deployWorkflowYaml())}
									>
										{#if copied === 'yaml'}<Check class="h-3.5 w-3.5" />{:else}<Copy
												class="h-3.5 w-3.5"
											/>{/if} Copy YAML
									</Button>
								</div>
								<pre
									class="max-h-64 overflow-auto rounded-lg border bg-muted/50 p-3 font-mono text-xs">{deployWorkflowYaml()}</pre>
							</li>
							<li>
								<p class="font-medium">3. Push</p>
								<p class="text-xs text-muted-foreground">
									Every commit deploys automatically from then on - Workers-Builds-style, with
									GitHub running the build. Make sure the repo carries the
									<code class="font-mono">cloudflarebase.json</code> written by
									<code class="font-mono">cloudflarebase init</code>.
								</p>
							</li>
						</ol>
					{/if}
				</Card.Content>
			</Card.Root>
		{/if}
	{/if}
</div>

<ConnectGithubDialog
	bind:open={connectOpen}
	projectId={data.projectId}
	installations={data.github.installations}
	takenApps={(data.claims ?? []).map((claim) => claim.appName)}
	{preferInstallation}
/>

<!-- Disconnecting stops deploys immediately; the workflow file goes with it. -->
<AlertDialog.Root
	open={disconnectTarget !== null}
	onOpenChange={(open) => {
		if (!open) disconnectTarget = null;
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Disconnect {disconnectTarget?.repoFullName}?</AlertDialog.Title>
			<AlertDialog.Description>
				Pushes stop deploying immediately.
				{#if disconnectTarget?.mode === 'build'}
					The workflow file this connection added is removed from the repository too.
				{/if}
				Everything already deployed keeps serving.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				disabled={disconnectBusy}
				onclick={disconnect}
				data-testid="confirm-disconnect-github"
			>
				{disconnectBusy ? 'Disconnecting…' : 'Disconnect'}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<!-- Mint dialog: the secret appears exactly once. -->
<Dialog.Root bind:open={mintOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Mint a deploy token</Dialog.Title>
			<Dialog.Description>
				Valid for deploys and branch creation on this project family. Stored hashed - the secret
				below is shown exactly once.
			</Dialog.Description>
		</Dialog.Header>
		{#if minted}
			<div class="space-y-3">
				<p class="text-sm">
					Token <span class="font-medium">{minted.name}</span>:
				</p>
				<div class="flex items-center gap-2">
					<code
						class="max-w-full flex-1 truncate rounded bg-muted px-2 py-1.5 font-mono text-xs"
						data-testid="minted-token">{minted.token}</code
					>
					<Button size="sm" variant="outline" onclick={() => copy('minted', minted!.token)}>
						{#if copied === 'minted'}<Check class="h-3.5 w-3.5" />{:else}<Copy
								class="h-3.5 w-3.5"
							/>{/if}
					</Button>
				</div>
				<Button
					size="sm"
					onclick={() => {
						minted = null;
						mintOpen = false;
					}}
				>
					Done
				</Button>
			</div>
		{:else}
			<form class="space-y-3" onsubmit={mintToken}>
				<div class="space-y-1.5">
					<Label for="token-name">Name</Label>
					<Input
						id="token-name"
						bind:value={mintName}
						placeholder="e.g. github:you/your-app"
						required
						maxlength={64}
						data-testid="token-name"
					/>
				</div>
				{#if mintError}
					<p class="text-sm text-destructive">{mintError}</p>
				{/if}
				<Dialog.Footer>
					<Button type="submit" disabled={mintBusy} data-testid="token-mint-submit">
						{mintBusy ? 'Minting…' : 'Mint'}
					</Button>
				</Dialog.Footer>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<!-- Revocation: confirmed, never a bare click. -->
<AlertDialog.Root
	open={revokeTarget !== null}
	onOpenChange={(open) => !open && (revokeTarget = null)}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Revoke {revokeTarget?.name}?</AlertDialog.Title>
			<AlertDialog.Description>
				Deploys using this token stop working immediately. This cannot be undone - mint a new token
				to reconnect CI.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action onclick={revokeToken} data-testid="confirm-revoke">
				{revokeBusy ? 'Revoking…' : 'Revoke'}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
