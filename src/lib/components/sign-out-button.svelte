<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button';
	import { CONSOLE_AUTH_BASE } from '$lib/console';
	import { LogOut } from '@lucide/svelte';

	/** The one sign-out control every console surface shares - the styling,
	 * the testid, and the /login redirect can never drift between shells. */
	let { class: className = 'h-8' }: { class?: string } = $props();

	let busy = $state(false);

	async function signOut() {
		busy = true;
		try {
			await fetch(`${CONSOLE_AUTH_BASE}/sign-out`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{}'
			});
			// ONE navigation: invalidating while still on the page re-runs its
			// loads without a session, and on a demo deployment /dashboard would
			// mint a throwaway project before the /login goto lands.
			await goto(resolve('/login'), { invalidateAll: true });
		} finally {
			busy = false;
		}
	}
</script>

<Button
	variant="ghost"
	size="sm"
	class={`gap-1.5 text-muted-foreground ${className}`}
	disabled={busy}
	onclick={signOut}
	aria-label="Sign out"
	data-testid="console-sign-out"
>
	<LogOut class="h-4 w-4" />
	Sign out
</Button>
