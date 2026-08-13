<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { CONSOLE_AUTH_BASE } from '$lib/console';

	/**
	 * The operator's avatar, and behind it the account editor - name via Better
	 * Auth update-user, email via change-email (a VERIFIED account approves the
	 * change from its current address; unverified ones - local dev - change
	 * immediately). One component so the account and project shells cannot
	 * drift. Pictures arrive with social sign-in; editing them waits for R2.
	 */
	let { user }: { user: { name: string; email: string; image: string | null } } = $props();

	let open = $state(false);
	let accountName = $state('');
	let accountEmail = $state('');
	let profileBusy = $state(false);
	let profileError = $state<string | null>(null);
	let profileSaved = $state(false);
	let emailBusy = $state(false);
	let emailError = $state<string | null>(null);
	let emailNotice = $state<string | null>(null);

	function openAccount() {
		accountName = user.name;
		accountEmail = user.email;
		profileError = null;
		profileSaved = false;
		emailError = null;
		emailNotice = null;
		open = true;
	}

	async function saveProfile(event: SubmitEvent) {
		event.preventDefault();
		profileBusy = true;
		profileError = null;
		profileSaved = false;
		try {
			const response = await fetch(`${CONSOLE_AUTH_BASE}/update-user`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: accountName.trim() })
			});
			if (!response.ok) {
				const body = (await response.json().catch(() => null)) as { message?: string } | null;
				profileError = body?.message ?? 'Could not update the profile.';
				return;
			}
			profileSaved = true;
			await invalidateAll();
		} catch {
			profileError = 'Could not reach the auth agent.';
		} finally {
			profileBusy = false;
		}
	}

	async function changeEmail(event: SubmitEvent) {
		event.preventDefault();
		const newEmail = accountEmail.trim();
		if (!newEmail || newEmail === user.email) {
			emailNotice = 'That is already your email.';
			return;
		}
		emailBusy = true;
		emailError = null;
		emailNotice = null;
		try {
			const response = await fetch(`${CONSOLE_AUTH_BASE}/change-email`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ newEmail, callbackURL: '/dashboard' })
			});
			if (!response.ok) {
				const body = (await response.json().catch(() => null)) as { message?: string } | null;
				emailError = body?.message ?? 'Could not change the email.';
				return;
			}
			emailNotice =
				'If your current address requires approval, a confirmation link is on its way there - otherwise the change is already active.';
			await invalidateAll();
		} catch {
			emailError = 'Could not reach the auth agent.';
		} finally {
			emailBusy = false;
		}
	}
</script>

<button
	type="button"
	class="rounded-full transition-opacity hover:opacity-80"
	onclick={openAccount}
	aria-label="Account settings"
	title={user.email}
	data-testid="account-button"
>
	{#if user.image}
		<img src={user.image} alt="" class="h-8 w-8 rounded-full border object-cover" />
	{:else}
		<span
			class="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary uppercase"
		>
			{(user.name || user.email).slice(0, 1)}
		</span>
	{/if}
</button>

<Dialog.Root bind:open>
	<Dialog.Content data-testid="account-panel">
		<Dialog.Header>
			<Dialog.Title>Account</Dialog.Title>
			<Dialog.Description>Your operator profile on this console.</Dialog.Description>
		</Dialog.Header>

		<form class="space-y-4" onsubmit={saveProfile}>
			<div class="flex items-center gap-4">
				{#if user.image}
					<img src={user.image} alt="" class="h-12 w-12 rounded-full border object-cover" />
				{:else}
					<span
						class="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-base font-semibold text-primary uppercase"
					>
						{(accountName || accountEmail).slice(0, 1)}
					</span>
				{/if}
				<div class="min-w-0 flex-1 space-y-1.5">
					<Label for="account-name">Name</Label>
					<Input id="account-name" bind:value={accountName} required maxlength={64} />
				</div>
			</div>
			{#if profileError}
				<p class="text-sm text-destructive" data-testid="account-profile-error">{profileError}</p>
			{:else if profileSaved}
				<p class="text-sm text-muted-foreground">Saved.</p>
			{/if}
			<div class="flex justify-end">
				<Button type="submit" variant="outline" disabled={profileBusy} data-testid="account-save">
					{profileBusy ? 'Saving…' : 'Save profile'}
				</Button>
			</div>
		</form>

		<form class="space-y-3 border-t pt-4" onsubmit={changeEmail}>
			<div class="space-y-1.5">
				<Label for="account-email">Email</Label>
				<Input id="account-email" type="email" bind:value={accountEmail} required />
			</div>
			{#if emailError}
				<p class="text-sm text-destructive" data-testid="account-email-error">{emailError}</p>
			{:else if emailNotice}
				<p class="text-sm text-muted-foreground" data-testid="account-email-notice">
					{emailNotice}
				</p>
			{/if}
			<div class="flex justify-end">
				<Button
					type="submit"
					variant="outline"
					disabled={emailBusy}
					data-testid="account-change-email"
				>
					{emailBusy ? 'Working…' : 'Change email'}
				</Button>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>
