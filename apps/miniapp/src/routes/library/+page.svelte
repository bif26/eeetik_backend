<script lang="ts">
	import { onMount } from 'svelte';
	import {
		api,
		REQUEST_TYPE_LABELS,
		type HistoryEntry
	} from '$lib/api';

	const PAGE_SIZE = 10;

	let entries = $state<HistoryEntry[]>([]);
	let loading = $state(true);
	let error = $state('');
	let currentPage = $state(1);

	onMount(() => {
		void load();
	});

	async function load() {
		loading = true;
		error = '';
		try {
			entries = await api.history();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load history';
		} finally {
			loading = false;
		}
	}

	const totalPages = $derived(Math.max(1, Math.ceil(entries.length / PAGE_SIZE)));
	const visibleEntries = $derived(
		entries.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
	);

	function statusBadgeClass(status: string): string {
		switch (status) {
			case 'completed':
				return 'badge-success';
			case 'failed':
				return 'badge-error';
			case 'expired':
				return 'badge-warning';
			default:
				return 'badge-info';
		}
	}

	function formatDate(iso?: string): string {
		if (!iso) {
			return '—';
		}

		return new Date(iso).toLocaleString();
	}
</script>

<svelte:head>
	<title>eeetik · Library</title>
</svelte:head>

<div class="card bg-base-100 shadow-xl">
	<div class="card-body gap-4">
		<div class="flex items-center justify-between">
			<h2 class="card-title">Past downloads</h2>
			<button class="btn btn-ghost btn-sm" onclick={() => void load()}>↻ Refresh</button>
		</div>

		{#if loading}
			<div class="flex flex-col gap-2">
				{#each Array(4) as _}
					<div class="skeleton h-10 w-full"></div>
				{/each}
			</div>
		{:else if error}
			<div class="alert alert-error text-sm">
				<span>{error}</span>
			</div>
		{:else if entries.length === 0}
			<div class="alert">
				<span>No downloads yet — paste a TikTok link on the home page!</span>
			</div>
		{:else}
			<div class="overflow-x-auto">
				<table class="table table-sm">
					<thead>
						<tr>
							<th>Media</th>
							<th>Format</th>
							<th>Status</th>
							<th>Date</th>
						</tr>
					</thead>
					<tbody>
						{#each visibleEntries as entry (entry.jobId)}
							<tr>
								<td class="max-w-32 truncate font-mono text-xs">{entry.uniqueId}</td>
								<td>{REQUEST_TYPE_LABELS[entry.requestType] ?? entry.requestType}</td>
								<td>
									<span class="badge badge-sm {statusBadgeClass(entry.status)}">
										{entry.status}
									</span>
								</td>
								<td class="text-xs opacity-70">{formatDate(entry.createdAt)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			{#if totalPages > 1}
				<div class="join self-center">
					<button
						class="btn btn-sm join-item"
						disabled={currentPage === 1}
						onclick={() => (currentPage -= 1)}
					>
						«
					</button>
					<button class="btn btn-sm join-item pointer-events-none">
						{currentPage} / {totalPages}
					</button>
					<button
						class="btn btn-sm join-item"
						disabled={currentPage === totalPages}
						onclick={() => (currentPage += 1)}
					>
						»
					</button>
				</div>
			{/if}
		{/if}
	</div>
</div>
