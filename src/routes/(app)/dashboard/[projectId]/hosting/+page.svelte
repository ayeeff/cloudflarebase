<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import type { DeployTokenInfo, GithubConnectionInfo, HostingOverview } from '$lib/agents';
	import GithubMark from '$lib/components/github-mark.svelte';
	import ConnectGithubDialog from './connect-github-dialog.svelte';
	import DeploysTable from './deploys-table.svelte';
	import { onMount } from 'svelte';
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
	import * as Tabs from '$lib/components/ui/tabs';
	import {
		AppWindow,
		Check,
		ChevronRight,
		Copy,
		ExternalLink,
		KeyRound,
		Rocket,
		Sparkles,
		Terminal
	} from '@lucide/svelte';

	let { data } = $props();

	// UI tests click SSR-rendered controls; without this attribute a click can
	// land before Svelte attaches its handler and silently vanish.
	let hydrated = $state(false);
	onMount(() => (hydrated = true));

	// Writable derived: the SSR payload wins on navigation, the poll overwrites
	// between loads.
	let overview: HostingOverview | null = $derived(data.overview);

	/**
	 * Apps the AGENT knows about, plus control-plane claims it has not been
	 * told about yet.
	 *
	 * The agent only learns an app exists when the console pushes the claim,
	 * and that happens at DEPLOY time - but claiming happens earlier, when a
	 * repository is connected or `init` runs. Without the merge the operator
	 * connects a repo, sees "No apps yet", and reasonably concludes it failed.
	 */
	const apps = $derived.by(() => {
		const deployed = overview?.apps ?? [];
		const known = new Set(deployed.map((app) => app.name));
		const pending = (data.claims ?? [])
			.filter((claim) => !known.has(claim.appName))
			.map((claim) => ({
				name: claim.appName,
				subdomain: claim.subdomain,
				// The console does not know the serving domain - the agent composes
				// URLs from HOSTING_DOMAIN - so show the claimed label, not a guess.
				url: null,
				deployCount: 0,
				lastDeployAt: null,
				createdAt: claim.createdAt
			}));
		return [...deployed, ...pending];
	});

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
</script>

<svelte:head>
	<title>Hosting · {data.projectId} · Cloudflarebase</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div
	class="mx-auto max-w-7xl space-y-5 px-3 py-5 sm:space-y-6 sm:px-6 sm:py-8"
	data-testid="hosting-page"
	data-hydrated={hydrated}
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
				{#if apps.length === 0}
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
					<div class="grid gap-3">
						{#each apps as app (app.name)}
							<!-- The card navigates to the app's own page (vars, secrets,
							     build settings, analytics, deletion), via a stretched link
							     on the title - the live URL underneath is its own anchor,
							     and anchors cannot nest. The primary outline and icon tile
							     mark it as the clickable object on this page, matching the
							     overview's product cards. -->
							<div
								class="relative flex flex-wrap items-center gap-3 rounded-lg border border-primary/30 bg-card p-4 transition-colors hover:border-primary/60 hover:bg-accent/40"
							>
								<div
									class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
								>
									<AppWindow class="h-5 w-5" strokeWidth={1.8} />
								</div>
								<div class="min-w-0 flex-1">
									<a
										href={resolve(
											'/(app)/dashboard/[projectId]/hosting/apps/[appName]/[[tab=hostingapp]]',
											{
												projectId: data.projectId,
												appName: app.name,
												tab: undefined as unknown as string
											}
										)}
										class="after:absolute after:inset-0"
										data-testid={`open-app-${app.name}`}
									>
										<p class="flex items-center gap-2 truncate text-sm font-semibold">
											{app.name}
											{#if app.deployCount === 0}
												<!-- Claimed but never deployed: connecting a repository
												     reserves the subdomain immediately, and the operator
												     should see it rather than an empty card. -->
												<Badge variant="outline" class="font-normal">Awaiting first deploy</Badge>
											{/if}
										</p>
									</a>
									{#if app.url}
										<!-- Above the stretched overlay, so the live app opens
										     instead of the settings page. -->
										<a
											href={app.url}
											target="_blank"
											rel="noopener noreferrer"
											class="relative z-10 inline-flex max-w-full items-center gap-1 truncate font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
											data-testid={`open-app-url-${app.name}`}
										>
											{app.url.replace('https://', '')}
											<ExternalLink class="h-3 w-3 shrink-0" />
										</a>
									{:else}
										<p class="truncate font-mono text-xs text-muted-foreground">{app.subdomain}</p>
									{/if}
								</div>
								<div class="shrink-0 text-right text-xs text-muted-foreground">
									{#if app.deployCount === 0}
										<p>Deploys on the next push</p>
									{:else}
										<p>{app.deployCount} deploy{app.deployCount === 1 ? '' : 's'}</p>
										{#if app.lastDeployAt}
											<p>last {timeAgo(app.lastDeployAt)}</p>
										{/if}
									{/if}
								</div>
								<ChevronRight class="h-4 w-4 shrink-0 text-muted-foreground" />
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
				<DeploysTable projectId={data.projectId} showApp pageSize={10} />
			</Card.Content>
		</Card.Root>

		{#if data.isRoot}
			<!-- Two answers to one question - how a deploy proves it may write to
			     this project - so they are tabs, not two stacked cards. Side by
			     side they read as two setup steps, and a lone "Mint token" button
			     under a card of its own made a credential look mandatory when
			     connecting GitHub means never handling one. GitHub leads because
			     it is the path that stores no secret. -->
			<Card.Root data-testid="hosting-deploy-access">
				<Card.Header>
					<Card.Title class="flex items-center gap-2 text-base">
						<KeyRound class="h-4 w-4 text-muted-foreground" /> Deploy access
					</Card.Title>
					<Card.Description>
						How a deploy authenticates. Pick one - you do not need both.
					</Card.Description>
				</Card.Header>
				<Card.Content>
					<Tabs.Root value="github">
						<Tabs.List class="mb-4">
							<Tabs.Trigger value="github" data-testid="tab-github">GitHub</Tabs.Trigger>
							<Tabs.Trigger value="token" data-testid="tab-token">Deploy token</Tabs.Trigger>
						</Tabs.List>

						<Tabs.Content value="token" class="space-y-3" data-testid="hosting-tokens">
							<p class="text-sm text-muted-foreground">
								Optional. CI's durable credential, for pipelines GitHub does not run: valid only for
								deploys and branch creation on this project and its branches. Secrets are shown once
								and stored hashed - revoking deletes the hash.
							</p>
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
							<Button
								size="sm"
								variant="outline"
								onclick={() => (mintOpen = true)}
								data-testid="mint-token"
							>
								Mint token
							</Button>
						</Tabs.Content>

						<Tabs.Content value="github" class="space-y-4" data-testid="hosting-github">
							<p class="text-sm text-muted-foreground">
								Push-to-deploy without a build farm, and without a credential you have to store. The
								default branch ships production; every other branch gets its own isolated preview at <code
									class="font-mono text-xs">&lt;app&gt;-&lt;branch&gt;</code
								>.
							</p>
							{#if data.github.configured}
								{#if data.github.connections.length}
									<!-- One repository per app, Workers/Pages-style: every
									     connection is its own row, and another repo can join as a
									     NEW app at any time. Per-row copy stays one line - the
									     app's own page carries the build settings. -->
									<div class="space-y-3" data-testid="github-connection">
										<div class="grid gap-2">
											{#each data.github.connections as connection (connection.appName)}
												<div
													class="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3"
													data-testid={`github-connection-${connection.appName}`}
												>
													<!-- Dark in BOTH themes on purpose: the repository is a
													     fixed identity, and the chip reads as one token
													     rather than a link that happens to be sitting there. -->
													<a
														class="inline-flex items-center gap-2 rounded-lg bg-neutral-900 px-2.5 py-1.5 font-mono text-xs text-neutral-50 transition-colors hover:bg-neutral-800 dark:bg-neutral-800 dark:hover:bg-neutral-700"
														href={`https://github.com/${connection.repoFullName}`}
														target="_blank"
														rel="noreferrer"
													>
														<GithubMark class="h-3.5 w-3.5 shrink-0" />
														{connection.repoFullName}
													</a>
													<div class="min-w-0 flex-1">
														<p class="truncate text-sm">
															deploys <code class="font-mono text-xs">{connection.appName}</code>
															<span class="text-muted-foreground">
																on push to
																<code class="font-mono text-xs"
																	>{connection.productionBranch ?? connection.defaultBranch}</code
																></span
															>
														</p>
														<p class="text-xs text-muted-foreground">
															{connection.mode === 'direct'
																? 'No build step - published directly'
																: "Builds on GitHub's runners, authenticated by identity token"}{connection.lastEventAt
																? ` · last push ${timeAgo(connection.lastEventAt)}`
																: ''}
														</p>
													</div>
													<Button
														size="sm"
														variant="outline"
														onclick={() => (disconnectTarget = connection)}
														data-testid={`disconnect-github-${connection.appName}`}
													>
														Disconnect
													</Button>
												</div>
											{/each}
										</div>
										<Button
											size="sm"
											variant="outline"
											class="gap-2"
											onclick={() => (connectOpen = true)}
											data-testid="connect-github"
										>
											<GithubMark class="h-4 w-4" /> Connect another repository
										</Button>
									</div>
								{:else}
									<div class="space-y-3">
										<p class="text-sm text-muted-foreground">
											Connect a repository and every push deploys itself. A site with no build step
											needs no workflow file at all; one that builds gets a workflow that
											authenticates with GitHub's identity token instead of a stored secret.
										</p>
										<Button
											class="gap-2"
											onclick={() => (connectOpen = true)}
											data-testid="connect-github"
										>
											<GithubMark class="h-4 w-4" /> Connect repository
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
						</Tabs.Content>
					</Tabs.Root>
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
