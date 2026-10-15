<script lang="ts">
        import { goto } from '$app/navigation';
        import { page } from '$app/state';
        import { api, type FormatOption, type PreviewData } from '$lib/api';
        import { appState } from '$lib/state.svelte';
        import { hapticFeedback } from '$lib/telegram';

        let preview = $state<PreviewData | null>(appState.preview);
        let selectedFormat = $state('');
        let loading = $state(false);
        let error = $state('');

        const url = page.url.searchParams.get('url') ?? appState.sourceUrl;

        $effect(() => {
                if (preview || !url) {
                        return;
                }

                void loadPreview();
        });

        async function loadPreview() {
                loading = true;
                error = '';
                try {
                        const response = await api.fetchMetadata(url);
                        preview = response.data;
                        appState.preview = response.data;
                        selectDefault();
                } catch (err) {
                        error = err instanceof Error ? err.message : 'Failed to load preview';
                } finally {
                        loading = false;
                }
        }

        function allFormats(): FormatOption[] {
                if (!preview) {
                        return [];
                }

                const formats = preview.availableFormats;
                return [...(formats.video ?? []), ...(formats.images ?? []), ...(formats.audio ?? [])];
        }

        function selectDefault() {
                if (!selectedFormat && preview) {
                        const formats = preview.availableFormats;
                        selectedFormat = formats.video?.[0]?.id ?? formats.images?.[0]?.id ?? formats.audio?.[0]?.id ?? '';
                }
        }

        async function startDownload() {
                if (!preview || !selectedFormat || loading) {
                        return;
                }

                loading = true;
                error = '';
                try {
                        const job = await api.prepare(preview.url || appState.sourceUrl, selectedFormat);
                        appState.jobId = job.jobId;
                        hapticFeedback('success');
                        await goto(`/queue?jobId=${encodeURIComponent(job.jobId)}`);
                } catch (err) {
                        error = err instanceof Error ? err.message : 'Failed to queue download';
                        hapticFeedback('error');
                } finally {
                        loading = false;
                }
        }
</script>

<svelte:head>
        <title>eeetik · Preview</title>
</svelte:head>

{#if loading && !preview}
        <div class="flex flex-col gap-4">
                <div class="skeleton h-48 w-full"></div>
                <div class="skeleton h-6 w-3/4"></div>
                <div class="skeleton h-4 w-1/2"></div>
        </div>
{:else if error && !preview}
        <div class="alert alert-error">
                <span>{error}</span>
        </div>
        <a class="btn btn-outline" href="/">Go back</a>
{:else if preview}
        <div class="card bg-base-100 shadow-xl">
                <div class="card-body gap-4">
                        {#if preview.type === 'video' && preview.thumbnail}
                                <figure class="overflow-hidden rounded-box">
                                        <img src={preview.thumbnail} alt={preview.title} class="h-48 w-full object-cover" />
                                </figure>
                        {:else if preview.type === 'image' && preview.images?.length}
                                <div class="flex gap-2 overflow-x-auto rounded-box">
                                        {#each preview.images.slice(0, 6) as image}
                                                <img src={image} alt="gallery" class="h-32 rounded-lg object-cover" />
                                        {/each}
                                </div>
                        {/if}

                        <h2 class="card-title text-lg leading-snug">{preview.title || 'Untitled'}</h2>
                        <div class="flex items-center gap-2 text-sm">
                                <span class="font-medium">{preview.author.nickname}</span>
                                <span class="badge badge-outline">{preview.type}</span>
                                {#if preview.duration}
                                        <span class="badge badge-ghost">{Math.round(preview.duration)}s</span>
                                {/if}
                        </div>

                        <div class="stats stats-vertical bg-base-200 shadow-none sm:stats-horizontal">
                                <div class="stat py-2">
                                        <div class="stat-title text-xs">Views</div>
                                        <div class="stat-value text-lg">{preview.stats.views}</div>
                                </div>
                                <div class="stat py-2">
                                        <div class="stat-title text-xs">Likes</div>
                                        <div class="stat-value text-lg">{preview.stats.likes}</div>
                                </div>
                                <div class="stat py-2">
                                        <div class="stat-title text-xs">Comments</div>
                                        <div class="stat-value text-lg">{preview.stats.comments}</div>
                                </div>
                        </div>

                        {#if preview.hashtags.length > 0}
                                <div class="flex flex-wrap gap-1">
                                        {#each preview.hashtags.slice(0, 8) as tag}
                                                <span class="badge badge-sm badge-secondary badge-outline">{tag}</span>
                                        {/each}
                                </div>
                        {/if}

                        <div class="divider my-0 text-xs opacity-50">Quality</div>

                        <div class="join w-full flex-wrap">
                                {#each allFormats() as format (format.id)}
                                        <input
                                                type="radio"
                                                name="quality"
                                                class="btn join-item flex-1"
                                                aria-label={format.label}
                                                value={format.id}
                                                bind:group={selectedFormat}
                                        />
                                {/each}
                        </div>
                        <p class="text-xs opacity-60">Selected: {selectedFormat.toUpperCase()}</p>

                        <button class="btn btn-primary" disabled={!selectedFormat || loading} onclick={startDownload}>
                                {#if loading}
                                        <span class="loading loading-spinner loading-sm"></span>
                                        Queuing…
                                {:else}
                                        Download
                                {/if}
                        </button>

                        <div class="progress progress-primary w-full" style="width: 100%"></div>

                        {#if error}
                                <div class="alert alert-error text-sm">
                                        <span>{error}</span>
                                </div>
                        {/if}
                </div>
        </div>
{/if}
