<script lang="ts">
	import { goto } from '$app/navigation';
	import { api } from '$lib/api';
	import { appState } from '$lib/state.svelte';

	let url = $state('');
	let loading = $state(false);
	let error = $state('');

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!url.trim() || loading) {
			return;
		}

		loading = true;
		error = '';
		try {
			const response = await api.fetchMetadata(url.trim());
			appState.preview = response.data;
			appState.sourceUrl = url.trim();
			await goto(`/preview?url=${encodeURIComponent(url.trim())}`);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Something went wrong';
		} finally {
			loading = false;
		}
	}
</script>

<svelte:head>
	<title>eeetik · TikTok downloader</title>
</svelte:head>

<div class="card bg-base-100 shadow-xl">
	<div class="card-body gap-4">
		<div class="flex items-center gap-2">
			<h1 class="card-title text-xl">eeetik</h1>
			<span class="badge badge-primary badge-outline">no watermark</span>
		</div>
		<p class="opacity-70">
			Paste a TikTok link to preview it and download video, audio or the full
			image gallery.
		</p>

		<form class="flex flex-col gap-3" onsubmit={submit}>
			<input
				type="url"
				class="input input-bordered w-full"
				placeholder="https://www.tiktok.com/@user/video/123..."
				bind:value={url}
				required
			/>
			<button type="submit" class="btn btn-primary" disabled={loading}>
				{#if loading}
					<span class="loading loading-spinner loading-sm"></span>
					Fetching…
				{:else}
					Preview link
				{/if}
			</button>
		</form>

		{#if error}
			<div class="alert alert-error text-sm">
				<span>{error}</span>
			</div>
		{/if}

		<div class="divider my-0 text-xs opacity-50">or</div>
		<p class="text-sm opacity-70">
			Send the link to the bot directly — downloads land in your chat either
			way.
		</p>
	</div>
</div>
