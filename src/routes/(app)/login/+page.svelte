<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import ConsoleShell from '$lib/components/console-shell.svelte';
	import { CONSOLE_AUTH_BASE } from '$lib/console';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';

	let { data } = $props();

	// First run: no owner yet, so the page claims the console instead of
	// signing in. Open mode has no claim step - the first account is just the
	// first sign-up - so claiming only ever renders in claimed mode.
	const claiming = $derived(!data.ownerExists && data.consoleSignups !== 'open');
	const open = $derived(data.consoleSignups === 'open');

	// A demo deployment has no operators at all - the agent refuses the claim,
	// so offering the form would only collect a doomed submission. The web and
	// agent DEMO_MODE flags only diverge in the e2e harness, which never
	// renders this page.
	const demoWithoutConsole = $derived(claiming && data.demoMode);

	const socialLabels: Record<string, string> = {
		google: 'Google',
		github: 'GitHub'
	};

	// OAuth callback failures bounce back here with ?error=<code> - the
	// errorCallbackURL passed to sign-in/social - instead of Better Auth's
	// bare error page.
	const oauthErrors: Record<string, string> = {
		account_not_linked: 'This email signed up with a password - use it to sign in.',
		unable_to_create_user: 'Sign-up was refused. A claimed console admits invited emails only.'
	};
	const oauthError = page.url.searchParams.get('error');

	// 'sign-in' | 'sign-up': what the form submits. Open mode offers both;
	// claimed mode keeps sign-up behind the "invited?" link (the agent admits
	// only emails holding a pending invitation). ?signup=1 (the landing nav's
	// Sign up button) starts on the registration form.
	let mode = $state<'sign-in' | 'sign-up'>(
		page.url.searchParams.has('signup') ? 'sign-up' : 'sign-in'
	);
	let name = $state('');
	let email = $state('');
	let password = $state('');
	let error = $state<string | null>(
		oauthError ? (oauthErrors[oauthError] ?? 'Social sign-in failed - try again.') : null
	);
	let submitting = $state(false);
	// Open-mode sign-up ends here: no session until the email is verified.
	let verifyNotice = $state(false);

	const signingUp = $derived(claiming || mode === 'sign-up');

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		submitting = true;
		error = null;

		try {
			const response = await fetch(
				`${CONSOLE_AUTH_BASE}/${signingUp ? 'sign-up' : 'sign-in'}/email`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					// callbackURL is where the emailed verification link lands after
					// verifying - the login page, not `/` (the marketing page on a
					// demo deployment). A failed unverified sign-in re-sends the
					// mail with the same destination.
					body: JSON.stringify(
						signingUp
							? { name, email, password, callbackURL: '/login' }
							: { email, password, callbackURL: '/login' }
					)
				}
			);

			if (!response.ok) {
				const body = (await response.json().catch(() => null)) as { message?: string } | null;
				error =
					body?.message ??
					(signingUp
						? 'Could not create the account.'
						: 'Incorrect email or password, or the email is not verified yet.');
				return;
			}

			// Open sign-ups require email verification, so there is no session to
			// land in yet - tell the visitor what happens next instead.
			if (signingUp && open) {
				verifyNotice = true;
				return;
			}

			await invalidateAll();
			await goto(data.next);
		} catch {
			error = 'Could not reach the auth agent.';
		} finally {
			submitting = false;
		}
	}

	/**
	 * Better Auth's social flow: the POST returns the provider's authorization
	 * URL and the browser navigates there; the OAuth callback lands the session
	 * cookie and redirects to callbackURL. In claimed mode unknown accounts
	 * bounce (the console refuses to create users beyond the owner and invited
	 * emails); open mode registers them implicitly. On the first-run claim the
	 * provider account simply becomes the owner.
	 */
	async function signInWithProvider(provider: string) {
		submitting = true;
		error = null;

		try {
			const response = await fetch(`${CONSOLE_AUTH_BASE}/sign-in/social`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					provider,
					callbackURL: data.next,
					// Callback failures return here (?error=<code>) instead of
					// stranding the visitor on Better Auth's error page.
					errorCallbackURL: `/login?next=${encodeURIComponent(data.next)}`
				})
			});
			const body = (await response.json().catch(() => null)) as { url?: string } | null;

			if (!response.ok || !body?.url) {
				error = `Could not start ${socialLabels[provider] ?? provider} sign-in.`;
				return;
			}
			window.location.href = body.url;
		} catch {
			error = 'Could not reach the auth agent.';
		} finally {
			submitting = false;
		}
	}
</script>

<svelte:head>
	<title
		>{demoWithoutConsole ? 'Demo deployment' : claiming ? 'Set up your console' : 'Sign in'} · Cloudflarebase</title
	>
	<meta name="robots" content="noindex" />
</svelte:head>

<ConsoleShell>
	{#if demoWithoutConsole}
		<div data-testid="console-demo-notice" class="space-y-6">
			<div class="space-y-1.5">
				<h1 class="text-2xl font-semibold tracking-tight">This is a demo deployment</h1>
				<p class="text-sm text-muted-foreground">
					There is no console to set up here. Demo deployments have no operators: every visitor gets
					an anonymous, self-erasing project instead of an account.
				</p>
			</div>

			<div class="space-y-3">
				<Button href={resolve('/dashboard')} class="w-full">Try the demo</Button>
				<p class="text-xs text-muted-foreground">
					Running this deployment yourself? Fleet monitoring lives at <a
						class="underline"
						href={resolve('/admin')}>/admin</a
					>, behind its own secret. To get a private console with real projects, deploy without
					<code class="font-mono">DEMO_MODE</code>.
				</p>
			</div>
		</div>
	{:else if verifyNotice}
		<div data-testid="console-verify-notice" class="space-y-6">
			<div class="space-y-1.5">
				<h1 class="text-2xl font-semibold tracking-tight">Check your inbox</h1>
				<p class="text-sm text-muted-foreground">
					We sent a verification link to <span class="font-medium">{email}</span>. Follow it, then
					sign in - accounts only activate once their email is verified.
				</p>
			</div>
			<Button
				variant="outline"
				class="w-full"
				onclick={() => {
					verifyNotice = false;
					mode = 'sign-in';
				}}
			>
				Back to sign in
			</Button>
		</div>
	{:else}
		<div data-testid="console-login" class="space-y-6">
			<div class="space-y-1.5">
				<h1 class="text-2xl font-semibold tracking-tight">
					{claiming ? 'Set up your console' : signingUp ? 'Create your account' : 'Sign in'}
				</h1>
				<p class="text-sm text-muted-foreground">
					{#if claiming}
						No owner yet. Create the first account - sign-up closes as soon as it exists.
					{:else if signingUp && open}
						Your projects, your data, on Cloudflare's edge. Verification email included.
					{:else if signingUp}
						Invited to an organization? Register with the invited email address.
					{:else}
						Sign in to manage your projects.
					{/if}
				</p>
			</div>

			<!-- Also offered on the first-run claim: the agent admits the first
			     account on every path, so the owner can be a Google/GitHub identity. -->
			{#if data.socialProviders.length > 0}
				<div class="space-y-2" data-testid="console-social-providers">
					{#each data.socialProviders as provider (provider)}
						<Button
							type="button"
							variant="outline"
							class="w-full"
							disabled={submitting}
							onclick={() => signInWithProvider(provider)}
						>
							Continue with {socialLabels[provider] ?? provider}
						</Button>
					{/each}
				</div>

				<div class="flex items-center gap-3 text-xs text-muted-foreground">
					<span class="h-px flex-1 bg-border"></span>
					or with email
					<span class="h-px flex-1 bg-border"></span>
				</div>
			{/if}

			<form class="space-y-4" onsubmit={submit}>
				{#if signingUp}
					<div class="space-y-1.5">
						<Label for="name">Name</Label>
						<Input id="name" bind:value={name} required autocomplete="name" />
					</div>
				{/if}

				<div class="space-y-1.5">
					<Label for="email">Email</Label>
					<Input id="email" type="email" bind:value={email} required autocomplete="email" />
				</div>

				<div class="space-y-1.5">
					<Label for="password">Password</Label>
					<Input
						id="password"
						type="password"
						bind:value={password}
						required
						minlength={signingUp ? 8 : undefined}
						autocomplete={signingUp ? 'new-password' : 'current-password'}
					/>
				</div>

				{#if error}
					<p class="text-sm text-destructive" data-testid="console-login-error">{error}</p>
				{/if}

				<Button type="submit" class="w-full" disabled={submitting} data-testid="console-submit">
					{submitting
						? 'Working…'
						: claiming
							? 'Create owner account'
							: signingUp
								? 'Create account'
								: 'Sign in'}
				</Button>
			</form>

			{#if !claiming}
				<p class="text-center text-xs text-muted-foreground">
					{#if signingUp}
						Already have an account?
						<button
							type="button"
							class="underline"
							data-testid="console-mode-signin"
							onclick={() => {
								mode = 'sign-in';
								error = null;
							}}
						>
							Sign in
						</button>
					{:else if open}
						New here?
						<button
							type="button"
							class="underline"
							data-testid="console-mode-signup"
							onclick={() => {
								mode = 'sign-up';
								error = null;
							}}
						>
							Create an account
						</button>
					{:else}
						<!-- Claimed consoles admit invited emails - teams without open
						     registration (docs/managed-service-design.md). -->
						Invited to an organization?
						<button
							type="button"
							class="underline"
							data-testid="console-mode-signup"
							onclick={() => {
								mode = 'sign-up';
								error = null;
							}}
						>
							Create your account
						</button>
					{/if}
				</p>
			{/if}
		</div>
	{/if}
</ConsoleShell>
