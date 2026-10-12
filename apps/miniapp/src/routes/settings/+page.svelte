<script lang="ts">
	import { onMount } from 'svelte';
	import { api, type MiniAppUser } from '$lib/api';
	import { hapticFeedback, getWebApp } from '$lib/telegram';

	let user = $state<MiniAppUser | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let saved = $state(false);

	let defaultQuality = $state('hd');
	let notifications = $state(true);
	let autoSendToChat = $state(true);

	onMount(() => {
		void load();
	});

	async function load() {
		loading = true;
		try {
			const response = await api.me();
			user = response.user;
			const settings = response.user?.settings ?? {};
			if (typeof settings.defaultQuality === 'string') {
				defaultQuality = settings.defaultQuality;
			}
			if (typeof settings.notifications === 'boolean') {
				notifications = settings.notifications;
			}
			if (typeof settings.autoSendToChat === 'boolean') {
				autoSendToChat = settings.autoSendToChat;
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load settings';
		} finally {
			loading = false;
		}
	}

	async function save() {
		saving = true;
		error = '';
		saved = false;
		try {
			const response = await api.updateSettings({
				defaultQuality,
				notifications,
				autoSendToChat
			});
			user = response.user;
			saved = true;
			hapticFeedback('success');

			// Persist the preference in Telegram CloudStorage (never localStorage).
			try {
				getWebApp()?.CloudStorage?.setItem('eeetik.defaultQuality', defaultQuality);
			} catch {
				// CloudStorage is unavailable in some contexts – best effort only.
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to save settings';
			hapticFeedback('error');
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head>
	<title>eeetik · Settings</title>
</svelte:head>

<div class="card bg-base-100 shadow-xl">
	<div class="card-body gap-4">
		<h2 class="card-title">Settings</h2>

		{#if loading}
			<div class="skeleton h-32 w-full"></div>
		{:else}
			<fieldset class="fieldset bg-base-200 rounded-box gap-3 p-4">
				<legend class="fieldset-legend">Profile</legend>
				<div class="text-sm">
					{#if user}
						<span class="font-medium">
							{user.firstName ?? user.username ?? 'Telegram user'}
						</span>
						<span class="opacity-60">· id {user.telegramId}</span>
					{:else}
						<span class="opacity-60">
							Signed in via Telegram initData (open the app inside Telegram).
						</span>
					{/if}
				</div>
			</fieldset>

			<fieldset class="fieldset bg-base-200 rounded-box gap-3 p-4">
				<legend class="fieldset-legend">Preferences</legend>

				<label class="label cursor-pointer justify-between">
					<span class="label-text">Default quality</span>
					<select class="select select-bordered select-sm" bind:value={defaultQuality}>
						<option value="hd">HD Video</option>
						<option value="sd">SD Video</option>
						<option value="audio">Audio MP3</option>
						<option value="zip">Images ZIP</option>
					</select>
				</label>

				<label class="label cursor-pointer justify-between">
					<span class="label-text">Bot notifications</span>
					<input type="checkbox" class="toggle toggle-primary" bind:checked={notifications} />
				</label>

				<label class="label cursor-pointer justify-between">
					<span class="label-text">Auto-send files to chat</span>
					<input type="checkbox" class="toggle toggle-primary" bind:checked={autoSendToChat} />
				</label>
			</fieldset>

			<button class="btn btn-primary" disabled={saving} onclick={() => void save()}>
				{#if saving}
					<span class="loading loading-spinner loading-sm"></span>
					Saving…
				{:else}
					Save settings
				{/if}
			</button>

			{#if saved}
				<div class="alert alert-success text-sm">
					<span>Settings saved.</span>
				</div>
			{/if}

			{#if error}
				<div class="alert alert-error text-sm">
					<span>{error}</span>
				</div>
			{/if}
		{/if}
	</div>
</div>
