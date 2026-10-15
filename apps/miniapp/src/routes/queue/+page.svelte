<script lang="ts">
        import { onMount } from 'svelte';
        import { page } from '$app/state';
        import { api, type JobStatusResponse } from '$lib/api';
        import { hapticFeedback } from '$lib/telegram';

        const jobId = page.url.searchParams.get('jobId') ?? '';

        let job = $state<JobStatusResponse | null>(null);
        let elapsedSeconds = $state(0);
        let error = $state('');
        let finished = $state(false);

        onMount(() => {
                if (!jobId) {
                        error = 'No job id provided.';
                        return;
                }

                const timer = setInterval(() => {
                        elapsedSeconds += 1;
                }, 1000);

                void poll();

                return () => clearInterval(timer);
        });

        async function poll() {
                if (finished) {
                        return;
                }

                try {
                        const response = await api.status(jobId);
                        job = response;

                        if (response.status === 'completed' || response.status === 'failed' || response.status === 'expired') {
                                finished = true;
                                hapticFeedback(response.status === 'completed' ? 'success' : 'error');
                                return;
                        }
                } catch (err) {
                        error = err instanceof Error ? err.message : 'Failed to fetch job status';
                        return;
                }

                setTimeout(() => void poll(), 2500);
        }

        const progressPercent = $derived(
                Math.min(95, 8 + Math.floor(Math.log2(elapsedSeconds + 1) * 20))
        );
</script>

<svelte:head>
        <title>eeetik · Queue</title>
</svelte:head>

<div class="card bg-base-100 shadow-xl">
        <div class="card-body items-center gap-4 text-center">
                <h2 class="card-title">Download status</h2>
                <p class="font-mono text-xs opacity-60">{jobId}</p>

                {#if !job}
                        <div class="flex flex-col items-center gap-3">
                                <div class="skeleton h-24 w-24 rounded-full"></div>
                                <div class="skeleton h-4 w-40"></div>
                        </div>
                {:else if job.status === 'completed'}
                        <div class="alert alert-success">
                                <span>
                                        ✅ Done! Your file is ready.
                                        {#if job.downloadUrl}
                                                It was also delivered to your Telegram chat.
                                        {:else}
                                                Open the bot chat to get it.
                                        {/if}
                                </span>
                        </div>
                        {#if job.downloadUrl}
                                <a
                                        class="btn btn-primary"
                                        href={job.downloadUrl}
                                        target="_blank"
                                        rel="noopener"
                                >
                                        💾 Save / open file
                                </a>
                        {/if}
                {:else if job.status === 'failed' || job.status === 'expired'}
                        <div class="alert alert-error">
                                <span>
                                        ❌ {job.errorMessage ?? 'The download failed. Please try again.'}
                                </span>
                        </div>
                {:else}
                        <div
                                class="radial-progress text-primary"
                                style="--value:{progressPercent}; --size:7rem;"
                                role="progressbar"
                        >
                                <span class="text-sm font-semibold">{elapsedSeconds}s</span>
                        </div>
                        <p class="text-sm opacity-70">
                                Preparing your file… it will appear in your Telegram chat when ready.
                        </p>
                {/if}

                {#if error}
                        <div class="alert alert-warning text-sm">
                                <span>{error}</span>
                        </div>
                {/if}

                <div class="card-actions">
                        <a class="btn btn-outline" href="/">Download another</a>
                </div>
        </div>
</div>
