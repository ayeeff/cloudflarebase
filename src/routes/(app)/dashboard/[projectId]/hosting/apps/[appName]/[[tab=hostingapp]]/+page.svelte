<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { HostingAnalytics } from '$lib/agents';
	import GithubMark from '$lib/components/github-mark.svelte';
	import ToolTabs from '$lib/components/tool-tabs.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as Chart from '$lib/components/ui/chart';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Select from '$lib/components/ui/select';
	import { ArrowLeft, ExternalLink, Rocket } from '@lucide/svelte';
	import { Area, AreaChart, Points } from 'layerchart';
	import { onMount } from 'svelte';
	import VarsEditor, { type VarsSavePayload } from '../../../vars-editor.svelte';
	import DeploysTable from '../../../deploys-table.svelte';

	let { data } = $props();

	// UI tests click SSR-rendered controls; without this attribute a click can
	// land before Svelte attaches its handler and silently vanish.
	let hydrated = $state(false);
	onMount(() => (hydrated = true));

	const base = $derived(`/dashboard/${data.projectId}/hosting/apps/${data.appName}`);
	const tabs = $derived([
		{ href: base, title: 'Overview', testId: 'app-overview', icon: 'rocket' },
		{
			href: `${base}/deployments`,
			title: 'Deployments',
			testId: 'app-deployments',
			icon: 'rocket'
		},
		{ href: `${base}/analytics`, title: 'Analytics', testId: 'app-analytics', icon: 'rocket' },
		{ href: `${base}/settings`, title: 'Settings', testId: 'app-settings', icon: 'rocket' }
	]);

	const timeAgo = (iso: string) => {
		const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
		if (seconds < 60) return 'just now';
		if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
		if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
		return `${Math.floor(seconds / 86400)}d ago`;
	};

	async function send(path: string, init: RequestInit): Promise<string | null> {
		const response = await fetch(`/api/projects/${data.projectId}${path}`, {
			...init,
			headers: init.body ? { 'content-type': 'application/json' } : undefined
		}).catch(() => null);
		if (!response) return 'The console did not answer.';
		if (!response.ok) {
			const body = (await response.json().catch(() => null)) as { error?: string } | null;
			return body?.error ?? 'That did not work.';
		}
		return null;
	}

	// --- Runtime variables and secrets --------------------------------------
	async function saveRuntimeEnv(payload: VarsSavePayload): Promise<string | null> {
		const app = encodeURIComponent(data.appName);
		const put = await send(`/hosting/apps/${app}/vars`, {
			method: 'PUT',
			body: JSON.stringify({ vars: payload.vars })
		});
		if (put) return put;
		for (const secret of payload.setSecrets) {
			const failure = await send(`/hosting/apps/${app}/secrets`, {
				method: 'POST',
				body: JSON.stringify(secret)
			});
			if (failure) return failure;
		}
		for (const name of payload.deleteSecrets) {
			const failure = await send(`/hosting/apps/${app}/secrets/${encodeURIComponent(name)}`, {
				method: 'DELETE'
			});
			if (failure) return failure;
		}
		await invalidateAll();
		return null;
	}

	// --- Build-time environment ----------------------------------------------
	async function saveBuildEnv(payload: VarsSavePayload): Promise<string | null> {
		const app = encodeURIComponent(data.appName);
		const put = await send(`/hosting/apps/${app}/build-vars`, {
			method: 'PUT',
			body: JSON.stringify({ vars: payload.vars })
		});
		if (put) return put;
		for (const secret of payload.setSecrets) {
			const failure = await send(
				`/hosting/apps/${app}/build-secrets/${encodeURIComponent(secret.name)}`,
				{ method: 'PUT', body: JSON.stringify({ value: secret.value }) }
			);
			if (failure) return failure;
		}
		for (const name of payload.deleteSecrets) {
			const failure = await send(`/hosting/apps/${app}/build-secrets/${encodeURIComponent(name)}`, {
				method: 'DELETE'
			});
			if (failure) return failure;
		}
		await invalidateAll();
		return null;
	}

	// --- Build settings (the committed workflow IS the setting) ---------------
	let buildCommand = $state('');
	let rootDir = $state('');
	let assetsDir = $state('');
	let productionBranch = $state('');
	let ignoredBranches = $state('');
	let settingsSeeded = $state('');
	$effect(() => {
		const connection = data.connection;
		const signature = JSON.stringify(connection);
		if (signature === settingsSeeded) return;
		settingsSeeded = signature;
		buildCommand = connection?.buildCommand ?? '';
		rootDir = connection?.rootDir ?? '';
		assetsDir = connection?.assetsDir ?? '';
		productionBranch = connection?.productionBranch ?? '';
		ignoredBranches = (connection?.ignoredBranches ?? []).join(', ');
	});
	const parsedIgnored = $derived(
		ignoredBranches
			.split(',')
			.map((entry) => entry.trim())
			.filter(Boolean)
	);
	const settingsDirty = $derived.by(() => {
		const connection = data.connection;
		if (!connection) return false;
		return (
			buildCommand.trim() !== (connection.buildCommand ?? '') ||
			rootDir.trim() !== (connection.rootDir ?? '') ||
			assetsDir.trim() !== (connection.assetsDir ?? '') ||
			productionBranch.trim() !== (connection.productionBranch ?? '') ||
			JSON.stringify(parsedIgnored) !== JSON.stringify(connection.ignoredBranches ?? [])
		);
	});
	let settingsBusy = $state(false);
	let settingsError = $state<string | null>(null);
	let settingsNotice = $state<string | null>(null);

	async function saveBuildSettings() {
		const connection = data.connection;
		if (!connection || settingsBusy || !settingsDirty) return;
		settingsBusy = true;
		settingsError = null;
		settingsNotice = null;
		try {
			const body: Record<string, unknown> = {
				productionBranch: productionBranch.trim() || null,
				ignoredBranches: parsedIgnored
			};
			if (connection.mode === 'build') {
				body.buildCommand = buildCommand.trim() || null;
				body.rootDir = rootDir.trim() || null;
			}
			body.assetsDir = assetsDir.trim() || null;
			const failure = await send(
				`/hosting/github/connections/${encodeURIComponent(data.appName)}`,
				{ method: 'PATCH', body: JSON.stringify(body) }
			);
			if (failure) {
				settingsError = failure;
				return;
			}
			settingsNotice =
				connection.mode === 'build' ? 'Saved - the workflow file was updated.' : 'Saved.';
			setTimeout(() => (settingsNotice = null), 4000);
			await invalidateAll();
		} finally {
			settingsBusy = false;
		}
	}

	// --- Analytics -------------------------------------------------------------
	let analyticsRange = $state('7');
	const analyticsRangeOptions = [
		{ value: '7', label: 'Last 7 days' },
		{ value: '30', label: 'Last 30 days' },
		{ value: '90', label: 'Last 90 days' }
	];
	let analytics = $state<HostingAnalytics | null>(null);

	$effect(() => {
		if (data.tab !== 'analytics') return;
		const range = analyticsRange;
		void (async () => {
			const response = await fetch(
				`/api/projects/${data.projectId}/hosting/apps/${encodeURIComponent(data.appName)}/analytics?days=${range}`
			).catch(() => null);
			if (!response?.ok) return;
			analytics = (await response.json().catch(() => null)) as HostingAnalytics | null;
		})();
	});

	// A continuous day axis: sparse buckets chart as gaps otherwise.
	const analyticsChart = $derived.by(() => {
		if (!analytics) return [];
		const byDay = new Map<string, { day: string; requests: number; errors: number }>(
			analytics.byDay.map((row) => [row.day, row])
		);
		const points: { date: Date; requests: number; errors: number }[] = [];
		for (let offset = analytics.days - 1; offset >= 0; offset -= 1) {
			const date = new Date(Date.now() - offset * 86_400_000);
			const day = date.toISOString().slice(0, 10);
			const row = byDay.get(day);
			points.push({ date, requests: row?.requests ?? 0, errors: row?.errors ?? 0 });
		}
		return points;
	});
	const analyticsChartConfig = {
		requests: { label: 'Requests', color: 'var(--chart-1)' },
		errors: { label: 'Errors (5xx)', color: 'var(--chart-5)' }
	};

	// --- Danger zone -----------------------------------------------------------
	let deleteOpen = $state(false);
	let deleteConfirm = $state('');
	let deleteBusy = $state(false);
	let deleteError = $state<string | null>(null);

	async function deleteApp() {
		if (deleteBusy) return;
		deleteBusy = true;
		deleteError = null;
		try {
			const failure = await send(`/hosting/apps/${encodeURIComponent(data.appName)}`, {
				method: 'DELETE'
			});
			if (failure) {
				deleteError = failure;
				return;
			}
			await goto(resolve('/(app)/dashboard/[projectId]/hosting', { projectId: data.projectId }));
		} finally {
			deleteBusy = false;
		}
	}
</script>

<svelte:head>
	<title>{data.appName} · Hosting · {data.projectId} · Cloudflarebase</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div
	class="mx-auto max-w-7xl space-y-5 px-3 py-5 sm:space-y-6 sm:px-6 sm:py-8"
	data-testid="hosting-app-page"
	data-hydrated={hydrated}
>
	<div class="space-y-3">
		<a
			href={resolve('/(app)/dashboard/[projectId]/hosting', { projectId: data.projectId })}
			class="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
			data-testid="back-to-apps"
		>
			<ArrowLeft class="h-3.5 w-3.5" /> All apps
		</a>
		<div class="flex flex-wrap items-center gap-3">
			<Rocket class="h-6 w-6 text-muted-foreground" />
			<div class="min-w-0">
				<h1 class="truncate text-2xl font-semibold tracking-tight">{data.appName}</h1>
				{#if data.app.url}
					<!-- eslint-disable svelte/no-navigation-without-resolve -- external app URL -->
					<a
						href={data.app.url}
						target="_blank"
						rel="noreferrer"
						class="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
						data-testid="app-url"
					>
						{data.app.url.replace('https://', '')}
						<ExternalLink class="h-3 w-3" />
					</a>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
				{:else}
					<p class="font-mono text-xs text-muted-foreground">{data.app.subdomain}</p>
				{/if}
			</div>
			{#if data.app.deployCount === 0}
				<Badge variant="outline" class="font-normal">Awaiting first deploy</Badge>
			{/if}
		</div>
		<ToolTabs items={tabs} />
	</div>

	{#if data.tab === 'overview'}
		<div class="grid gap-4 sm:grid-cols-3">
			<Card.Root data-testid="app-stat-deploys">
				<Card.Header>
					<Card.Description>Deploys</Card.Description>
					<Card.Title class="text-2xl" data-testid="stat-value">{data.app.deployCount}</Card.Title>
				</Card.Header>
			</Card.Root>
			<Card.Root>
				<Card.Header>
					<Card.Description>Last deploy</Card.Description>
					<Card.Title class="text-2xl">
						{data.app.lastDeployAt ? timeAgo(data.app.lastDeployAt) : '—'}
					</Card.Title>
				</Card.Header>
			</Card.Root>
			<Card.Root>
				<Card.Header>
					<Card.Description>Source</Card.Description>
					<Card.Title class="truncate text-base leading-8">
						{#if data.connection}
							<span class="inline-flex items-center gap-1.5">
								<GithubMark class="h-4 w-4 shrink-0" />
								<span class="truncate font-mono text-sm">{data.connection.repoFullName}</span>
							</span>
						{:else}
							CLI deploys
						{/if}
					</Card.Title>
				</Card.Header>
			</Card.Root>
		</div>

		{#if data.connection}
			<Card.Root data-testid="app-connection-summary">
				<Card.Header>
					<Card.Title class="text-base">Push to deploy</Card.Title>
					<Card.Description>
						Pushes to
						<code class="font-mono text-xs"
							>{data.connection.productionBranch ?? data.connection.defaultBranch}</code
						>
						deploy production; every other branch gets an isolated preview at
						<code class="font-mono text-xs">&lt;app&gt;-&lt;branch&gt;</code>.
						{#if data.connection.ignoredBranches.length}
							Ignored: <code class="font-mono text-xs"
								>{data.connection.ignoredBranches.join(', ')}</code
							>.
						{/if}
					</Card.Description>
				</Card.Header>
			</Card.Root>
		{/if}

		<Card.Root>
			<Card.Header>
				<Card.Title class="text-base">Latest deploys</Card.Title>
			</Card.Header>
			<Card.Content class="space-y-3">
				<DeploysTable projectId={data.projectId} app={data.appName} pageSize={5} />
			</Card.Content>
		</Card.Root>
	{:else if data.tab === 'deployments'}
		<Card.Root data-testid="app-deploys">
			<Card.Header>
				<Card.Title class="text-base">Deployments</Card.Title>
				<Card.Description>Every deploy of this app, newest first.</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-3">
				<DeploysTable projectId={data.projectId} app={data.appName} pageSize={10} />
			</Card.Content>
		</Card.Root>
	{:else if data.tab === 'analytics'}
		<Card.Root data-testid="hosting-analytics">
			<Card.Header>
				<div>
					<Card.Title class="text-base">Requests</Card.Title>
					<Card.Description>
						Requests and 5xx errors served at
						<code class="font-mono text-xs">{data.app.subdomain}</code>.
					</Card.Description>
				</div>
				<Card.Action class="self-start">
					<Select.Root type="single" bind:value={analyticsRange}>
						<Select.Trigger
							size="sm"
							class="w-36"
							aria-label="Analytics range"
							data-testid="hosting-analytics-range"
						>
							{analyticsRangeOptions.find((option) => option.value === analyticsRange)?.label}
						</Select.Trigger>
						<Select.Content>
							{#each analyticsRangeOptions as option (option.value)}
								<Select.Item value={option.value} label={option.label} />
							{/each}
						</Select.Content>
					</Select.Root>
				</Card.Action>
			</Card.Header>
			<Card.Content>
				{#if !analytics}
					<div class="h-52 w-full animate-pulse rounded-lg bg-muted/50" aria-hidden="true"></div>
				{:else if ['connected', 'local'].includes(analytics.engine.status)}
					<div class="mb-4 flex flex-wrap gap-6 text-sm" data-testid="hosting-analytics-totals">
						<div>
							<p class="text-muted-foreground">Requests</p>
							<p class="text-xl font-semibold">{analytics.totals.requests.toLocaleString()}</p>
						</div>
						<div>
							<p class="text-muted-foreground">Errors (5xx)</p>
							<p class="text-xl font-semibold">{analytics.totals.errors.toLocaleString()}</p>
						</div>
						<div>
							<p class="text-muted-foreground">Avg duration</p>
							<p class="text-xl font-semibold">{Math.round(analytics.totals.avgDurationMs)} ms</p>
						</div>
					</div>
					<Chart.Container
						config={analyticsChartConfig}
						class="aspect-auto h-52 w-full"
						data-testid="hosting-analytics-chart"
					>
						<AreaChart
							data={analyticsChart}
							x="date"
							series={[
								{
									key: 'requests',
									label: 'Requests',
									color: analyticsChartConfig.requests.color
								},
								{ key: 'errors', label: 'Errors (5xx)', color: analyticsChartConfig.errors.color }
							]}
							props={{
								yAxis: { ticks: 4 },
								xAxis: {
									ticks: analyticsRange === '7' ? analyticsChart.map((point) => point.date) : 6,
									format: (value: Date) =>
										value.toLocaleDateString(
											undefined,
											analyticsRange === '7'
												? { weekday: 'short' }
												: { month: 'short', day: 'numeric' }
										)
								}
							}}
						>
							{#snippet marks()}
								<Area
									seriesKey="requests"
									fill={analyticsChartConfig.requests.color}
									fillOpacity={0.18}
									line={{ strokeWidth: 2.5, stroke: analyticsChartConfig.requests.color }}
								/>
								<Area
									seriesKey="errors"
									fill={analyticsChartConfig.errors.color}
									fillOpacity={0.18}
									line={{ strokeWidth: 2, stroke: analyticsChartConfig.errors.color }}
								/>
								<Points
									seriesKey="requests"
									r={analyticsRange === '7' ? 3.5 : 2.5}
									fill="var(--background)"
									stroke={analyticsChartConfig.requests.color}
									strokeWidth={1.5}
								/>
							{/snippet}
							{#snippet tooltip()}
								<Chart.Tooltip
									indicator="line"
									labelFormatter={(value: unknown) =>
										value instanceof Date
											? value.toLocaleDateString(undefined, {
													weekday: 'long',
													month: 'long',
													day: 'numeric'
												})
											: String(value)}
								/>
							{/snippet}
						</AreaChart>
					</Chart.Container>
				{:else}
					<div
						class="flex h-24 items-center justify-center rounded-lg border border-dashed px-4 text-center text-sm text-muted-foreground"
						data-testid="hosting-analytics-degraded"
					>
						{analytics.engine.status === 'write-only'
							? 'Requests are being recorded. Add Analytics Engine read credentials (CF_ACCOUNT_ID + CF_ANALYTICS_API_TOKEN) to visualize them.'
							: 'Analytics Engine reads are temporarily unavailable.'}
					</div>
				{/if}
			</Card.Content>
		</Card.Root>
	{:else if data.tab === 'settings'}
		<Card.Root data-testid="hosting-vars-card">
			<Card.Header>
				<Card.Title class="text-base">Variables and secrets</Card.Title>
				<Card.Description>
					The app's environment, at runtime and at build time. Text values upload as plain-text
					bindings on every deploy (they win over CLI-declared vars of the same name) and apply to
					the live script when saved; secrets are written through to Cloudflare and survive
					redeploys - their values are never shown again. GitHub builds export this whole set before
					the build step, so framework-inlined values are present too.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<VarsEditor
					idPrefix="hosting-vars"
					vars={data.vars}
					secrets={data.secrets}
					secretsEnabled={data.app.deployCount > 0}
					secretsDisabledReason="Secrets attach to the deployed script - deploy once first."
					save={saveRuntimeEnv}
				/>
			</Card.Content>
		</Card.Root>

		{#if data.connection}
			<Card.Root data-testid="hosting-build-env-card">
				<Card.Header>
					<Card.Title class="text-base">Build environment</Card.Title>
					<Card.Description>
						Build-only overrides. Variables and secrets above are already exported into the GitHub
						Actions build; anything set here exists only at build time and wins over a matching
						name. Secrets are encrypted at rest and fetched by the workflow with its OIDC identity;
						branch builds share this set.
					</Card.Description>
				</Card.Header>
				<Card.Content>
					<VarsEditor
						idPrefix="hosting-build"
						vars={data.buildEnv?.vars ?? []}
						secrets={data.buildEnv?.secrets ?? []}
						secretsEnabled={data.buildEnv?.encryptionConfigured ?? false}
						secretsDisabledReason="Build secrets need the HOSTING_MASTER_KEY secret on the hosting agent."
						save={saveBuildEnv}
					/>
				</Card.Content>
			</Card.Root>

			<Card.Root data-testid="hosting-build-settings">
				<Card.Header>
					<Card.Title class="text-base">Build settings</Card.Title>
					<Card.Description>
						{#if data.connection.mode === 'build'}
							Saving updates the workflow file in
							<code class="font-mono text-xs">{data.connection.repoFullName}</code> - the committed workflow
							is where these settings live.
						{:else}
							This connection deploys the pushed tree directly - no build step. Reconnect the
							repository to change the mode.
						{/if}
					</Card.Description>
				</Card.Header>
				<Card.Content class="space-y-4">
					<div class="grid gap-4 sm:grid-cols-2">
						{#if data.connection.mode === 'build'}
							<div class="space-y-1.5">
								<Label for="hosting-build-command">Build command</Label>
								<Input
									id="hosting-build-command"
									bind:value={buildCommand}
									placeholder="npm run build --if-present"
									class="font-mono text-xs"
									data-testid="hosting-build-command"
								/>
							</div>
							<div class="space-y-1.5">
								<Label for="hosting-root-dir">Root directory</Label>
								<Input
									id="hosting-root-dir"
									bind:value={rootDir}
									placeholder="repository root"
									class="font-mono text-xs"
									data-testid="hosting-root-dir"
								/>
							</div>
						{/if}
						<div class="space-y-1.5">
							<Label for="hosting-output-dir">
								{data.connection.mode === 'build' ? 'Output directory' : 'Publish directory'}
							</Label>
							<Input
								id="hosting-output-dir"
								bind:value={assetsDir}
								placeholder={data.connection.mode === 'build' ? 'autodetected' : 'repository root'}
								class="font-mono text-xs"
								data-testid="hosting-output-dir"
							/>
						</div>
						<div class="space-y-1.5">
							<Label for="hosting-production-branch">Production branch</Label>
							<Input
								id="hosting-production-branch"
								bind:value={productionBranch}
								placeholder={data.connection.defaultBranch}
								class="font-mono text-xs"
								data-testid="hosting-production-branch"
							/>
							<p class="text-xs text-muted-foreground">
								Deploys the root project; every other branch deploys its own preview.
							</p>
						</div>
						<div class="space-y-1.5">
							<Label for="hosting-ignored-branches">Ignored branches</Label>
							<Input
								id="hosting-ignored-branches"
								bind:value={ignoredBranches}
								placeholder="tmp, renovate/*"
								class="font-mono text-xs"
								data-testid="hosting-ignored-branches"
							/>
							<p class="text-xs text-muted-foreground">
								Comma-separated names or <code class="font-mono">*</code> globs; pushes to these never
								deploy.
							</p>
						</div>
					</div>
					<div class="flex flex-wrap items-center gap-2">
						<Button
							size="sm"
							disabled={settingsBusy || !settingsDirty}
							onclick={saveBuildSettings}
							data-testid="hosting-build-save"
						>
							{settingsBusy ? 'Saving…' : 'Save build settings'}
						</Button>
						{#if settingsError}
							<span class="text-sm text-destructive" data-testid="hosting-build-error"
								>{settingsError}</span
							>
						{/if}
						{#if settingsNotice}
							<span class="text-sm text-muted-foreground" data-testid="hosting-build-feedback"
								>{settingsNotice}</span
							>
						{/if}
					</div>
				</Card.Content>
			</Card.Root>
		{/if}

		<Card.Root class="border-destructive/40" data-testid="hosting-danger-zone">
			<Card.Header>
				<Card.Title class="text-base">Danger zone</Card.Title>
				<Card.Description>
					Deleting stops <code class="font-mono text-xs">{data.app.subdomain}</code> serving, erases its
					deploy history and environment, and releases the subdomain for anyone to claim.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<Button
					variant="destructive"
					size="sm"
					onclick={() => {
						deleteOpen = true;
						deleteConfirm = '';
						deleteError = null;
					}}
					data-testid={`delete-app-${data.appName}`}
				>
					Delete app
				</Button>
			</Card.Content>
		</Card.Root>
	{/if}
</div>

<!-- App deletion: typed-name confirm (the settings-page convention - a plain
     Dialog so a failure stays visible instead of closing with the click). -->
<Dialog.Root bind:open={deleteOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Delete {data.appName}?</Dialog.Title>
			<Dialog.Description>
				The deployed site at <code class="font-mono text-xs">{data.app.subdomain}</code> stops serving,
				its deploy history is erased, and the subdomain is released for anyone to claim. A connected repository
				is disconnected too. This cannot be undone.
			</Dialog.Description>
		</Dialog.Header>
		<div class="space-y-1.5">
			<Label for="delete-app-confirm">
				Type <span class="font-mono">{data.appName}</span> to confirm
			</Label>
			<Input
				id="delete-app-confirm"
				bind:value={deleteConfirm}
				class="font-mono text-xs"
				autocomplete="off"
				data-testid="delete-app-confirm"
			/>
			{#if deleteError}
				<p class="text-sm text-destructive" data-testid="delete-app-error">{deleteError}</p>
			{/if}
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (deleteOpen = false)}>Cancel</Button>
			<Button
				variant="destructive"
				disabled={deleteBusy || deleteConfirm.trim() !== data.appName}
				onclick={deleteApp}
				data-testid="confirm-delete-app"
			>
				{deleteBusy ? 'Deleting…' : 'Delete app'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
