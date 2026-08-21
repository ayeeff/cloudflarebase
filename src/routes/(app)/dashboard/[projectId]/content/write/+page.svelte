<script lang="ts">
	import ContentManager from '$lib/components/admin/ContentManager.svelte';
	let { data, form } = $props();
</script>

<ContentManager {data} {form} title="Write" />
