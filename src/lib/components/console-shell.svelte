<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import GithubLogo from '$lib/components/github-logo.svelte';
	import ModeToggle from '$lib/components/mode-toggle.svelte';
	import { Button } from '$lib/components/ui/button';
	import { CONSOLE_AUTH_BASE } from '$lib/console';
	import { LogOut } from '@lucide/svelte';
	import type { Snippet } from 'svelte';

	/**
	 * Shell for the pre-project console surfaces - sign-in, first-run claim, and
	 * the project list. The brand panel is the only place a self-hosted install
	 * says what it is, so it carries the positioning rather than decoration.
	 *
	 * The panel follows the theme; only the terminal card inside it is
	 * theme-stable espresso, via a scoped `dark` class that makes the shadcn
	 * tokens inside the card resolve dark in both themes (a terminal is
	 * naturally dark). Never touches the root theme state.
	 *
	 * It collapses below `lg`, where the content column takes the full width.
	 */
	let {
		children,
		wide = false,
		signedIn = false
	}: {
		children: Snippet;
		/** Widen the content column for lists; forms stay narrow. Wide surfaces
		 * also top-align instead of centering - a list floating mid-viewport
		 * reads as broken on tall screens; a form centered there reads as calm. */
		wide?: boolean;
		/** Renders the sign-out control. The operator surfaces that sit in this
		 * shell (projects, organization, cli-auth) always have a session; the
		 * login page never does. */
		signedIn?: boolean;
	} = $props();

	let signingOut = $state(false);

	async function signOut() {
		signingOut = true;
		try {
			await fetch(`${CONSOLE_AUTH_BASE}/sign-out`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{}'
			});
			await invalidateAll();
			await goto(resolve('/login'));
		} finally {
			signingOut = false;
		}
	}
</script>

<div class="grid min-h-svh lg:grid-cols-2">
	<aside
		class="relative hidden flex-col justify-between overflow-hidden border-r bg-muted/40 p-10 lg:flex"
	>
		<!-- Warm wash behind the panel, keyed off the mark's orange. -->
		<div
			aria-hidden="true"
			class="pointer-events-none absolute -top-32 -left-24 h-96 w-96 rounded-full bg-primary/10 blur-3xl"
		></div>

		<!-- Faint engineering dot grid, fading toward the lower panel. -->
		<div
			aria-hidden="true"
			class="pointer-events-none absolute inset-0 bg-[radial-gradient(var(--color-border)_1px,transparent_1px)] mask-[linear-gradient(200deg,black_15%,transparent_70%)] bg-size-[22px_22px]"
		></div>

		<a
			href={resolve('/')}
			class="relative flex w-fit items-center gap-2.5 transition-opacity hover:opacity-80"
		>
			<img src="/brand/mark.svg" alt="" class="h-7 w-7" />
			<span class="text-lg font-semibold tracking-tight">Cloudflarebase</span>
		</a>

		<div class="relative mx-auto w-full max-w-md space-y-6">
			<h2 class="text-3xl leading-tight font-semibold tracking-tight text-balance">
				The open-source backend built on Cloudflare.
			</h2>
			<p class="text-sm leading-relaxed text-muted-foreground">
				Every project gets its own agent - a Durable Object running Better Auth over its own SQLite
				database, at the edge, in your account.
			</p>

			<!-- A terminal is naturally dark: the scoped `dark` class keeps this
			     card espresso in both themes while the panel follows the theme. -->
			<div
				class="dark space-y-1.5 rounded-lg border bg-card p-4 font-mono text-xs leading-relaxed text-foreground shadow-[0_10px_26px_-14px_oklch(0.1_0.01_60/60%)]"
			>
				<p><span class="text-primary">$</span> npx cloudflarebase init my-app</p>
				<p><span class="text-primary">$</span> cloudflarebase deploy</p>
				<p>
					<span class="text-[oklch(0.72_0.15_150)]">✓</span> Deployed
					<span class="text-muted-foreground">- my-app.cfbase.dev</span>
				</p>
			</div>

			<div
				class="flex items-center gap-2.5 font-mono text-[11px] tracking-wide text-muted-foreground"
			>
				<span
					class="size-1.5 shrink-0 rounded-full bg-[oklch(0.72_0.15_150)] shadow-[0_0_7px_oklch(0.72_0.15_150/80%)]"
				></span>
				console · auth-agent · SQLite at the edge
			</div>
		</div>

		<div class="relative flex items-center gap-4 text-sm text-muted-foreground">
			<a
				href="https://github.com/cloudflarebase/cloudflarebase"
				class="flex items-center gap-1.5 transition-colors hover:text-foreground"
				rel="noreferrer noopener"
				target="_blank"
			>
				<GithubLogo class="h-4 w-4" /> GitHub
			</a>
			<span aria-hidden="true">·</span>
			<a href={resolve('/')} class="transition-colors hover:text-foreground">Docs</a>
		</div>
	</aside>

	<main
		class="relative flex flex-col items-center px-4 {wide
			? 'pt-16 pb-10 lg:py-20'
			: 'justify-center py-10'}"
	>
		<div class="absolute top-4 right-4 flex items-center gap-1">
			{#if signedIn}
				<Button
					variant="ghost"
					size="sm"
					class="text-muted-foreground"
					disabled={signingOut}
					onclick={signOut}
					data-testid="console-sign-out"
				>
					<LogOut class="size-4" /> Sign out
				</Button>
			{/if}
			<ModeToggle variant="ghost" />
		</div>

		<!-- The mark repeats here only where the brand panel is hidden. -->
		<a href={resolve('/')} class="mb-8 flex items-center gap-2.5 lg:hidden">
			<img src="/brand/mark.svg" alt="" class="h-6 w-6" />
			<span class="font-semibold tracking-tight">Cloudflarebase</span>
		</a>

		<div class="w-full {wide ? 'max-w-xl' : 'max-w-sm'}">
			{@render children()}
		</div>
	</main>
</div>
