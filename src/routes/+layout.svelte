<script lang="ts">
	import './layout.css';
	import { ModeWatcher } from 'mode-watcher';
	import { beforeNavigate, onNavigate } from '$app/navigation';
	import { page, updated } from '$app/state';

	let { children } = $props();
	const canonicalUrl = $derived(`https://cloudflarebase.com${page.url.pathname}`);

	// Inside the dashboard the shell (sidebar, header, agent pane) persists and
	// the content pane plays its own keyed entry transition - a ROOT view
	// transition there would translate/scale/blur the whole shell on every
	// tool-page hop, which reads as a layout shift. So the full-page cinematic
	// only plays when the navigation actually changes context (marketing,
	// login, entering or leaving the dashboard).
	const inDashboard = (routeId: string | null | undefined): boolean =>
		routeId?.startsWith('/(app)/dashboard') ?? false;

	// A deploy replaces this Worker's whole asset manifest, so the hashed chunks
	// an open tab still points at stop existing (docs in $lib/stale-build). Once
	// the version poll notices a newer build, hand the next navigation to the
	// browser instead of routing it client-side: a full page load fetches the
	// new module graph, where a client navigation would import a 404.
	beforeNavigate(({ willUnload, to }) => {
		if (updated.current && !willUnload && to?.url) {
			location.href = to.url.href;
		}
	});

	onNavigate((navigation) => {
		if (
			!document.startViewTransition ||
			window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
			(inDashboard(navigation.from?.route.id) && inDashboard(navigation.to?.route.id))
		) {
			return;
		}

		return new Promise<void>((resolve) => {
			document.startViewTransition(async () => {
				resolve();
				await navigation.complete;
			});
		});
	});
</script>

<svelte:head>
	<link rel="canonical" href={canonicalUrl} />
	<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
	<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
	<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
	<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
	<link rel="manifest" href="/site.webmanifest" />
	<meta name="theme-color" media="(prefers-color-scheme: light)" content="#faf7f1" />
	<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0a0705" />
	<meta property="og:site_name" content="Cloudflarebase" />
	<meta property="og:type" content="website" />
	<meta property="og:url" content={canonicalUrl} />
	<meta property="og:image" content="https://cloudflarebase.com/brand/github-header.png" />
	<meta
		property="og:image:alt"
		content="Cloudflarebase - the open-source backend built for Cloudflare"
	/>
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:image" content="https://cloudflarebase.com/brand/github-header.png" />
</svelte:head>
<ModeWatcher />
<div class="app-viewport">{@render children()}</div>
