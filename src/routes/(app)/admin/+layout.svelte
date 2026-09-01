<script lang="ts">
	import { page } from '$app/state';
	import { Folder, Map, FileText, LayoutTemplate, Shield, LogOut, RefreshCw } from '@lucide/svelte';

	let { data, children } = $props();

	let loginError = $state('');
	let loggingIn = $state(false);

	async function submitLogin(event: SubmitEvent) {
		event.preventDefault();
		loginError = '';
		loggingIn = true;
		const form = event.currentTarget as HTMLFormElement;
		const password = (new FormData(form).get('password') ?? '').toString();
		try {
			// Preserve any ?redirect= the content gate handed us (gate sends users
			// here from /dashboard/geo-site/content/* when they aren't authed).
			const redirectParam = window.location.search || '';
			// redirect:'manual' so we see the 303 instead of letting fetch follow it
			// to the target page (which would leave us parsing HTML as JSON and
			// wrongly reporting "Login failed." even though the cookie was set).
			const res = await fetch('/admin/login' + redirectParam, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ password }).toString(),
				redirect: 'manual'
			});
			if (res.type === 'opaqueredirect' || res.status === 0) {
				const target =
					new URLSearchParams(redirectParam.replace(/^\?/, '')).get('redirect') || '/admin/maps';
				window.location.href = target;
				return;
			}
			const j = (await res.json().catch(() => ({}))) as { error?: string };
			loginError = j.error ?? 'Login failed.';
		} catch {
			loginError = 'Network error during login.';
		} finally {
			loggingIn = false;
		}
	}

	async function logout() {
		await fetch('/admin/logout', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: ''
		});
		window.location.href = '/admin';
	}

	const navItems = [
		{ href: '/admin', label: 'Fleet', icon: Shield },
		{ href: '/admin/categories', label: 'Categories', icon: Folder },
		{ href: '/admin/maps', label: 'Maps', icon: Map },
		{ href: '/admin/articles', label: 'Articles', icon: FileText },
		{ href: '/admin/blog', label: 'Blog Posts', icon: FileText },
		{ href: '/admin/write', label: 'Write', icon: FileText },
		{ href: '/admin/templates', label: 'Templates', icon: LayoutTemplate },
		{ href: '/admin/update', label: 'Update', icon: RefreshCw }
	];

	const isActive = (href: string) =>
		href === '/admin' ? page.url.pathname === '/admin' : page.url.pathname.startsWith(href);
</script>

{#if !data.authed}
	<div class="flex min-h-screen items-center justify-center bg-muted/30 p-4">
		<div class="w-full max-w-sm rounded-lg border border-border/40 bg-background p-6 shadow-sm">
			<div class="mb-4 flex items-center gap-2">
				<Shield class="size-4 text-muted-foreground" />
				<span class="text-sm font-semibold">Geo Admin</span>
			</div>
			{#if !data.configured}
				<p class="text-sm text-destructive">
					ADMIN_SECRET is not configured on this deployment, so the admin console is locked. Set the
					ADMIN_SECRET var and redeploy.
				</p>
			{:else}
				<form onsubmit={submitLogin} class="flex flex-col gap-3">
					<label class="text-sm font-medium" for="password">Admin password</label>
					<input
						id="password"
						name="password"
						type="password"
						autocomplete="current-password"
						class="rounded-md border border-border bg-background px-3 py-2 text-sm"
						required
					/>
					{#if loginError}
						<p class="text-xs text-destructive">{loginError}</p>
					{/if}
					<button
						type="submit"
						disabled={loggingIn}
						class="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
					>
						{loggingIn ? 'Signing in…' : 'Sign in'}
					</button>
				</form>
			{/if}
		</div>
	</div>
{:else}
	<div class="flex min-h-screen flex-col sm:flex-row">
		<!-- Sidebar -->
		<aside
			class="flex shrink-0 flex-col border-b border-border/40 bg-muted/30 sm:w-56 sm:border-r sm:border-b-0"
		>
			<div class="flex items-center justify-between px-4 py-4">
				<span class="flex items-center gap-2">
					<Shield class="size-4 text-muted-foreground" />
					<span class="text-sm font-semibold">Geo Admin</span>
				</span>
				<button
					type="button"
					onclick={logout}
					title="Sign out"
					class="text-muted-foreground hover:text-foreground"
				>
					<LogOut class="size-4" />
				</button>
			</div>
			<nav class="flex flex-row gap-1 px-2 pb-2 sm:flex-col">
				{#each navItems as item}
					<a
						href={item.href}
						class="flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted
						{isActive(item.href) ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground'}"
					>
						<item.icon class="size-4" />
						<span>{item.label}</span>
					</a>
				{/each}
			</nav>
		</aside>

		<!-- Content -->
		<main class="flex-1 overflow-auto">
			{@render children()}
		</main>
	</div>
{/if}
