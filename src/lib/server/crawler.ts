/**
 * Whether a request came from a crawler rather than a person.
 *
 * Used on exactly one surface: the bare `/dashboard` entry, which on a demo
 * deployment mints an anonymous visitor their own throwaway project. A crawler
 * IS an anonymous visitor, so Googlebot following the landing page's demo link
 * created a real Durable Object and an append-only `demo_project` row on every
 * pass - inflating the all-time demo counter with traffic that never saw the
 * product - and then indexed the resulting project page under the /dashboard
 * URL, where the id it names is erased days later by the demo TTL.
 *
 * `\w*bot` rather than a bare `bot` substring: phone UAs like `CUBOT_NOTE`
 * exist, and word boundaries keep a real visitor on a Cubot handset out of it.
 * A missing user-agent is deliberately NOT a crawler - some API clients send
 * none, and being wrong in that direction only costs one demo project.
 */
const CRAWLER =
	/\b(?:\w*bot|crawler|crawling|spider|slurp|facebookexternalhit|feedfetcher|archiver|scrapy|nutch|preview)\b/i;

export function isCrawler(userAgent: string | null): boolean {
	return !!userAgent && CRAWLER.test(userAgent);
}
