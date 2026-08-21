/**
 * Whether a request came from an automated fetcher rather than a person.
 *
 * Used on exactly one surface: the bare `/dashboard` entry, which on a demo
 * deployment mints an anonymous visitor their own throwaway project. An
 * automated fetcher IS an anonymous visitor, so Googlebot following the landing
 * page's demo link created a real Durable Object and an append-only
 * `demo_project` row on every pass - inflating the all-time demo counter with
 * traffic that never saw the product - and then indexed the resulting project
 * page under the /dashboard URL, where the id it names is erased days later by
 * the demo TTL.
 *
 * TWO families, and the second was missed at first. Search crawlers announce
 * themselves (`\w*bot`, `crawler`, `spider`), but LINK PREVIEW fetchers - the
 * unfurler that runs when someone pastes a URL into a chat - mostly do not, and
 * they hit exactly the same URL for exactly the same reason. WhatsApp is the
 * clearest case: `WhatsApp/2.23.20.0` contains none of the crawler words, so it
 * minted a project per paste.
 *
 * This list is a cost reducer, never the correctness mechanism. iMessage sends
 * an ordinary Safari user-agent and is genuinely indistinguishable from a
 * person, so what actually keeps a shared `/dashboard` link from previewing as
 * somebody's demo project is the Open Graph handling in `src/routes/+layout.svelte`
 * - which needs no sniffing at all. Being wrong here costs one demo project, or
 * one redirect to the landing page where the demo link lives; being wrong there
 * put a stranger's project id on a share card.
 *
 * `\w*bot` rather than a bare `bot` substring: phone UAs like `CUBOT_NOTE`
 * exist, and word boundaries keep a real visitor on a Cubot handset out of it.
 * A missing user-agent is deliberately NOT a crawler - some API clients send
 * none, and being wrong in that direction only costs one demo project.
 */
const CRAWLER =
	/\b(?:\w*bot|crawler|crawling|spider|slurp|facebookexternalhit|feedfetcher|archiver|scrapy|nutch|preview)\b/i;

/**
 * Link-preview fetchers whose user-agent carries none of the words above.
 *
 * Deliberately excludes the ones that double as in-app BROWSERS (Snapchat and
 * Flipboard both put their name in a real person's user-agent), since matching
 * those would bounce a human off the demo they asked for.
 */
const UNFURLER =
	/\b(?:whatsapp|embedly|iframely|vkshare|nuzzel|cardyb|mastodon|pleroma|akkoma|misskey|slack-imgproxy|google-inspectiontool|metainspector)\b/i;

export function isCrawler(userAgent: string | null): boolean {
	return !!userAgent && (CRAWLER.test(userAgent) || UNFURLER.test(userAgent));
}
