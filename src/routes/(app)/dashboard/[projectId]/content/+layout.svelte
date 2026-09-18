<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Card from '$lib/components/ui/card';
	import { Shield, Lock, Loader2 } from '@lucide/svelte';

	let { data, children } = $props();

	let password = $state('');
	let loginError = $state('');
	let loading = $state(false);

	async function handleUnlock(event: SubmitEvent) {
		event.preventDefault();
		loginError = '';
		loading = true;

		try {
			const res = await fetch('/admin/login', {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ password }).toString(),
				redirect: 'manual'
			});

			if (res.type === 'opaqueredirect' || res.status === 0 || res.status === 303 || res.ok) {
				password = '';
				await invalidateAll();
				return;
			}

			const json = (await res.json().catch(() => ({}))) as { error?: string };
			loginError = json.error ?? 'Incorrect password.';
		} catch {
			loginError = 'Network error during unlock.';
		} finally {
			loading = false;
		}
	}
</script>

{#if !data.authed}
	<div class="flex min-h-[60vh] items-center justify-center p-4">
		<Card.Root class="w-full max-w-md border-border/60 shadow-lg">
			<Card.Header class="space-y-1 text-center">
				<div class="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
					<Lock class="size-6" />
				</div>
				<Card.Title class="text-xl font-semibold">Content Management Locked</Card.Title>
				<Card.Description>
					Enter the admin password to manage geo-site content, maps, categories, and datasets.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				{#if !data.configured}
					<p class="text-center text-sm text-destructive">
						ADMIN_SECRET is not configured on this deployment.
					</p>
				{:else}
					<form onsubmit={handleUnlock} class="space-y-4">
						<div class="space-y-2">
							<Label for="admin-password">Admin Password</Label>
							<Input
								id="admin-password"
								name="password"
								type="password"
								autocomplete="current-password"
								placeholder="Enter password…"
								bind:value={password}
								required
								autofocus
							/>
						</div>
						{#if loginError}
							<p class="text-sm font-medium text-destructive">{loginError}</p>
						{/if}
						<Button type="submit" class="w-full" disabled={loading || !password}>
							{#if loading}
								<Loader2 class="mr-2 size-4 animate-spin" />
								Unlocking…
							{:else}
								<Shield class="mr-2 size-4" />
								Unlock Content Tools
							{/if}
						</Button>
					</form>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>
{:else}
	{@render children()}
{/if}
