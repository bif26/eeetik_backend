<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { backButton, init } from '@telegram-apps/sdk';
	import { applyTelegramTheme, initTelegram } from '$lib/telegram';

	let { children } = $props();

	onMount(() => {
		// @telegram-apps/sdk may throw outside a Telegram launch – never fatal.
		try {
			init();
			backButton.mount();
		} catch {
			// Running in a plain browser (dev mode) – fall back silently.
		}

		initTelegram();
		applyTelegramTheme();
	});
</script>

<div class="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-4 p-4">
	<main class="flex-1">
		{@render children()}
	</main>
	<footer class="pb-2 text-center text-xs opacity-60">
		eeetik Mini App · downloads delivered straight to your Telegram chat
	</footer>
</div>
