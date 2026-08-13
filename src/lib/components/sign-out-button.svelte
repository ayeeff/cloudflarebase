<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { signOutConsole } from '$lib/sign-out';
	import { LogOut } from '@lucide/svelte';

	/** Sign-out as a standalone icon button, for the one surface with no avatar
	 * to hang a menu off: the /login + /cli-auth shell. Everywhere an operator
	 * avatar renders - both dashboard shells, every breakpoint - the menu behind
	 * it owns this action instead. The request itself lives in $lib/sign-out, so
	 * the button and the menu item cannot drift. */
	let { class: className = 'h-8 w-8' }: { class?: string } = $props();

	let busy = $state(false);

	async function signOut() {
		busy = true;
		try {
			await signOutConsole();
		} finally {
			busy = false;
		}
	}
</script>

<Button
	variant="ghost"
	size="icon"
	class={`text-muted-foreground ${className}`}
	disabled={busy}
	onclick={signOut}
	aria-label="Sign out"
	title="Sign out"
	data-testid="console-sign-out"
>
	<LogOut class="h-4 w-4" />
</Button>
