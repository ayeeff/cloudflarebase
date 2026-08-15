<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as RadioGroup from '$lib/components/ui/radio-group';
	import * as Select from '$lib/components/ui/select';
	import GithubMark from '$lib/components/github-mark.svelte';
	import { Check, Loader2, Lock, Search } from '@lucide/svelte';

	/**
	 * Connect a GitHub repository to this project (Phase B).
	 *
	 * Which deploy mode a repository gets is inspected rather than asked: one
	 * with a build script goes through GitHub's runners (`build`), one that is
	 * already deployable goes straight from the push webhook (`direct`). The
	 * operator can override, and the summary sentence states what will happen
	 * in plain English before they commit to it.
	 */

	interface Installation {
		id: number;
		accountLogin: string;
	}
	interface Repo {
		id: number;
		fullName: string;
		defaultBranch: string;
		private: boolean;
		updatedAt: string | null;
	}
	interface Inspection {
		suggestedMode: 'build' | 'direct';
		assetsDir: string;
		hasBuildScript: boolean;
		staticDirs: string[];
		hasIndexHtml: boolean;
		framework: { id: string; label: string; note: string | null } | null;
		buildCommand: string | null;
		outputDir: string;
		packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun';
	}

	let {
		open = $bindable(false),
		projectId,
		installations,
		takenApps,
		preferInstallation = null
	}: {
		open?: boolean;
		projectId: string;
		installations: Installation[];
		takenApps: string[];
		/** Account to preselect - the one just installed, on the return leg. */
		preferInstallation?: number | null;
	} = $props();

	let installationId = $state<number | null>(null);
	let repos = $state<Repo[]>([]);
	let reposLoading = $state(false);
	let query = $state('');
	let selected = $state<Repo | null>(null);
	let inspecting = $state(false);

	let mode = $state<'build' | 'direct'>('build');
	let assetsDir = $state('');
	let buildCommand = $state('');
	let packageManager = $state<'npm' | 'pnpm' | 'yarn' | 'bun'>('npm');
	let framework = $state<Inspection['framework']>(null);
	let appName = $state('');
	let showSettings = $state(false);

	let busy = $state(false);
	let error = $state<string | null>(null);

	const base = $derived(`/api/projects/${projectId}/hosting/github`);
	const filtered = $derived(
		query.trim()
			? repos.filter((repo) => repo.fullName.toLowerCase().includes(query.trim().toLowerCase()))
			: repos
	);
	const accountLabel = $derived(
		installations.find((entry) => entry.id === installationId)?.accountLogin ?? 'Select an account'
	);

	/** Repo name -> a legal app name; the operator can edit it before connecting. */
	function suggestAppName(fullName: string): string {
		const name = fullName
			.split('/')[1]
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, '-')
			.replace(/-{2,}/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 48)
			.replace(/-+$/, '');
		return name.length >= 3 ? name : `${name}-app`.slice(0, 48);
	}

	async function loadRepos(installation: number) {
		reposLoading = true;
		error = null;
		try {
			const response = await fetch(`${base}/repos?installation=${installation}`);
			const body = (await response.json().catch(() => null)) as {
				repos?: Repo[];
				error?: string;
			} | null;
			if (!response.ok) {
				error = body?.error ?? 'Could not list repositories.';
				repos = [];
				return;
			}
			repos = body?.repos ?? [];
		} finally {
			reposLoading = false;
		}
	}

	// Repositories belong to an installation, so opening the dialog or switching
	// accounts reloads them and drops a selection that is no longer in the list.
	$effect(() => {
		if (!open) return;
		const installation =
			installationId ??
			// Only honour the hint if it actually landed in the list; a stale one
			// would leave the picker pointing at an account that is not there.
			(preferInstallation && installations.some((entry) => entry.id === preferInstallation)
				? preferInstallation
				: null) ??
			installations[0]?.id ??
			null;
		if (installation === null) return;
		installationId = installation;
		selected = null;
		void loadRepos(installation);
	});

	async function select(repo: Repo) {
		selected = repo;
		showSettings = false;
		appName = suggestAppName(repo.fullName);
		inspecting = true;
		try {
			const response = await fetch(
				`${base}/repos?installation=${installationId}&repo=${encodeURIComponent(repo.fullName)}`
			);
			const body = (await response.json().catch(() => null)) as {
				inspection?: Inspection;
			} | null;
			// A failed inspection is not a failed connect: build mode is the safe
			// default, and the operator can still change it.
			const inspection = body?.inspection;
			mode = inspection?.suggestedMode ?? 'build';
			framework = inspection?.framework ?? null;
			packageManager = inspection?.packageManager ?? 'npm';
			// One field, two meanings: what direct mode publishes, or where a
			// build lands ('' = the CLI autodetects).
			assetsDir = mode === 'direct' ? (inspection?.assetsDir ?? '') : (inspection?.outputDir ?? '');
			buildCommand = inspection?.buildCommand ?? '';
		} finally {
			inspecting = false;
		}
	}

	/** Sends the operator to GitHub to install the app or widen its access. */
	async function manageOnGithub() {
		const response = await fetch(`${base}/install`);
		const body = (await response.json().catch(() => null)) as { url?: string } | null;
		if (body?.url) window.location.href = body.url;
	}

	async function connect() {
		if (!selected || !installationId) return;
		busy = true;
		error = null;
		try {
			const response = await fetch(`${base}/connections`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					installationId,
					repoFullName: selected.fullName,
					appName: appName.trim(),
					mode,
					// Direct: '' means the repository root. Build: '' means the CLI
					// autodetects, so it travels as "not set".
					assetsDir: mode === 'direct' ? assetsDir.trim() : assetsDir.trim() || undefined,
					buildCommand: mode === 'build' ? buildCommand.trim() || undefined : undefined,
					packageManager: mode === 'build' ? packageManager : undefined
				})
			});
			const body = (await response.json().catch(() => null)) as { error?: string } | null;
			if (!response.ok) {
				error = body?.error ?? 'Could not connect the repository.';
				return;
			}
			open = false;
			// The card, the app list, and the claim all change together.
			await invalidateAll();
		} finally {
			busy = false;
		}
	}

	/** The sentence the operator reads before committing. */
	const summary = $derived.by(() => {
		if (!selected) return '';
		if (mode === 'direct') {
			return `Every push to ${selected.defaultBranch} publishes ${assetsDir || 'the repository root'} directly. No Actions minutes are used, and nothing is written to your repository.`;
		}
		const output = assetsDir ? ` and deploys ${assetsDir}` : ' and deploys the output';
		return `A workflow is added to your repository. Every push to ${selected.defaultBranch} builds on GitHub's runners${output}. No secret is stored - deploys authenticate with GitHub's identity token.`;
	});
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg" data-testid="connect-github-dialog">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<GithubMark class="h-4 w-4" /> Connect a repository
			</Dialog.Title>
			<Dialog.Description>
				Push to deploy. The default branch ships production; every other branch gets its own
				isolated preview.
			</Dialog.Description>
		</Dialog.Header>

		{#if !installations.length}
			<div class="space-y-3 py-2 text-sm">
				<p class="text-muted-foreground">
					Install the Cloudflarebase app on your GitHub account and pick the repositories it may
					reach. You can change that selection on GitHub at any time.
				</p>
				<Button class="gap-2" onclick={manageOnGithub} data-testid="install-github-app">
					<GithubMark class="h-4 w-4" /> Install on GitHub
				</Button>
			</div>
		{:else}
			<div class="space-y-4">
				<div class="space-y-1.5">
					<Label for="gh-account">Account</Label>
					<Select.Root
						type="single"
						value={String(installationId ?? '')}
						onValueChange={(value) => (installationId = value ? Number(value) : null)}
					>
						<Select.Trigger id="gh-account" class="w-full" data-testid="github-account">
							{accountLabel}
						</Select.Trigger>
						<Select.Content>
							{#each installations as installation (installation.id)}
								<Select.Item value={String(installation.id)}>
									{installation.accountLogin}
								</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</div>

				<div class="space-y-1.5">
					<div class="relative">
						<Search
							class="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground"
						/>
						<Input
							bind:value={query}
							placeholder="Search repositories…"
							class="pl-8"
							aria-label="Search repositories"
						/>
					</div>
					<div class="max-h-52 overflow-y-auto rounded-lg border" data-testid="github-repo-list">
						{#if reposLoading}
							<p class="p-4 text-sm text-muted-foreground">Loading repositories…</p>
						{:else if !filtered.length}
							<p class="p-4 text-sm text-muted-foreground">
								{repos.length ? 'No repository matches that search.' : 'No repositories available.'}
							</p>
						{:else}
							{#each filtered as repo (repo.id)}
								<button
									type="button"
									class="flex w-full items-center gap-2 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-muted/50 {selected?.id ===
									repo.id
										? 'bg-muted'
										: ''}"
									onclick={() => select(repo)}
								>
									<span class="flex-1 truncate font-mono text-xs">{repo.fullName}</span>
									{#if repo.private}
										<Lock class="h-3 w-3 shrink-0 text-muted-foreground" />
									{/if}
									{#if selected?.id === repo.id}
										<Check class="h-3.5 w-3.5 shrink-0 text-primary" />
									{/if}
								</button>
							{/each}
						{/if}
					</div>
					<button
						type="button"
						class="text-xs text-muted-foreground underline-offset-4 hover:underline"
						onclick={manageOnGithub}
					>
						Repository missing? Adjust the app's access on GitHub
					</button>
				</div>

				{#if selected}
					<div class="space-y-3 rounded-lg border bg-muted/30 p-3">
						{#if inspecting}
							<p class="flex items-center gap-2 text-sm text-muted-foreground">
								<Loader2 class="h-3.5 w-3.5 animate-spin" /> Inspecting {selected.fullName}…
							</p>
						{:else}
							<div class="space-y-1.5">
								<Label for="gh-app">Deploy as</Label>
								<Input id="gh-app" bind:value={appName} class="font-mono text-xs" />
								{#if takenApps.includes(appName.trim())}
									<p class="text-xs text-muted-foreground">
										Reuses the existing app <code class="font-mono">{appName.trim()}</code>.
									</p>
								{/if}
							</div>

							{#if framework}
								<p class="text-xs text-muted-foreground" data-testid="github-framework">
									Detected <span class="font-medium text-foreground">{framework.label}</span>
								</p>
							{/if}
							{#if mode === 'build'}
								<div class="grid gap-3 sm:grid-cols-2">
									<div class="space-y-1.5">
										<Label for="gh-build">Build command</Label>
										<Input
											id="gh-build"
											bind:value={buildCommand}
											placeholder="npm run build"
											class="font-mono text-xs"
											data-testid="github-build-command"
										/>
									</div>
									<div class="space-y-1.5">
										<Label for="gh-output">Output directory</Label>
										<Input
											id="gh-output"
											bind:value={assetsDir}
											placeholder="autodetected"
											class="font-mono text-xs"
											data-testid="github-output-dir"
										/>
									</div>
								</div>
							{/if}
							{#if framework?.note}
								<p class="text-xs text-amber-600 dark:text-amber-500" data-testid="github-note">
									{framework.note}
								</p>
							{/if}

							<p class="text-sm" data-testid="github-summary">{summary}</p>

							{#if !showSettings}
								<button
									type="button"
									class="text-xs text-muted-foreground underline-offset-4 hover:underline"
									onclick={() => (showSettings = true)}
								>
									Change how it deploys
								</button>
							{:else}
								<RadioGroup.Root bind:value={mode} class="gap-2">
									<div class="flex items-start gap-2">
										<RadioGroup.Item value="build" id="gh-mode-build" class="mt-0.5" />
										<Label for="gh-mode-build" class="font-normal">
											Build on GitHub Actions
											<span class="block text-xs text-muted-foreground">
												Adds a workflow to your repository. Needed when the app has a build step.
											</span>
										</Label>
									</div>
									<div class="flex items-start gap-2">
										<RadioGroup.Item value="direct" id="gh-mode-direct" class="mt-0.5" />
										<Label for="gh-mode-direct" class="font-normal">
											Deploy the files as they are
											<span class="block text-xs text-muted-foreground">
												No workflow, no runner, no Actions minutes. For prebuilt or static sites.
											</span>
										</Label>
									</div>
								</RadioGroup.Root>
								{#if mode === 'direct'}
									<div class="space-y-1.5">
										<Label for="gh-assets">Directory to publish</Label>
										<Input
											id="gh-assets"
											bind:value={assetsDir}
											placeholder="dist (blank = repository root)"
											class="font-mono text-xs"
										/>
									</div>
								{/if}
							{/if}
						{/if}
					</div>
				{/if}

				{#if error}
					<p class="text-sm text-destructive" data-testid="github-connect-error">{error}</p>
				{/if}
			</div>

			<Dialog.Footer>
				<Button variant="outline" onclick={() => (open = false)}>Cancel</Button>
				<Button
					disabled={!selected || inspecting || busy || appName.trim().length < 3}
					onclick={connect}
					data-testid="github-connect-submit"
				>
					{busy ? 'Connecting…' : 'Connect'}
				</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
