import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCrawler } from './crawler';

/**
 * Both halves matter and they fail differently: a missed fetcher mints a
 * throwaway Durable Object and an all-time counter row, while a false positive
 * bounces a real person off the demo they clicked. The Cubot case is the one
 * that made the word boundary necessary.
 */

test('search crawlers are recognised', () => {
	for (const ua of [
		'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
		'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
		'Mozilla/5.0 (compatible; YandexBot/3.0)',
		'facebookexternalhit/1.1',
		'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
		'Twitterbot/1.0',
		'Slackbot-LinkExpanding 1.0'
	]) {
		assert.equal(isCrawler(ua), true, ua);
	}
});

test('link-preview fetchers without a crawler word are recognised', () => {
	// The family that was missed: these hit /dashboard exactly like a crawler
	// does, and none of them carries `bot`, `crawler`, or `spider`.
	for (const ua of [
		'WhatsApp/2.23.20.0',
		'WhatsApp/2.19.81 A',
		'Embedly +1.0',
		'Iframely/1.3.1',
		'Mozilla/5.0 (compatible; vkShare; +http://vk.com/dev/Share)',
		'Bluesky Cardyb/1.1',
		'http.rb/5.1.1 (Mastodon/4.2.1; +https://example.social/)',
		'Slack-ImgProxy (+https://api.slack.com/robots)'
	]) {
		assert.equal(isCrawler(ua), true, ua);
	}
});

test('real people are not mistaken for fetchers', () => {
	for (const ua of [
		// The handset that made `\w*bot` a word-boundary match.
		'Mozilla/5.0 (Linux; Android 9; CUBOT_NOTE_S) AppleWebKit/537.36 Chrome/78',
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
		'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile Safari/604.1',
		// In-app browsers: a person is behind these, so they must keep the demo.
		'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Snapchat/12.75.0.44 (like Safari/604.1)',
		'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Flipboard/4.3.15'
	]) {
		assert.equal(isCrawler(ua), false, ua);
	}
});

test('an absent user-agent is a person, not a fetcher', () => {
	// Deliberate: some API clients send none, and being wrong this way costs
	// one demo project.
	assert.equal(isCrawler(null), false);
	assert.equal(isCrawler(''), false);
});
