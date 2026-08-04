// Tool execution: cache lookup → provider call(s) → JSON text result.
// Runtime failures return { isError: true } tool results so the calling model
// can read and react to them; only schema violations are protocol errors.

import type { Env } from './env';
import type { FetchPageArgs, FindCommunitiesArgs, SearchArgs, ThreadArgs } from './mcp/handlers';
import {
	cacheKey,
	getCached,
	putCached,
	COMMUNITY_CACHE_TTL,
	PAGE_CACHE_TTL,
	SEARCH_CACHE_TTL,
	THREAD_CACHE_TTL
} from './cache';
import { redditFindCommunities, redditSearch, redditThread } from './providers/reddit';
import type { SearchResult } from './providers/types';
import { xSearch, xThread } from './providers/x';
import { youtubeSearch, youtubeThread } from './providers/youtube';
import { assertPublicHttpsUrl, directFetch } from './providers/page';
import { firecrawlScrape } from './providers/firecrawl';
import { fetchTranscript, isVideoUrl } from './providers/transcript';

export interface ToolResult {
	text: string;
	isError: boolean;
}

function ok(text: string): ToolResult {
	return { text, isError: false };
}

function fail(err: unknown, context: string): ToolResult {
	const message = err instanceof Error ? err.message : String(err);
	return { text: `${context}: ${message}`, isError: true };
}

export async function runSocialSearch(env: Env, args: SearchArgs): Promise<ToolResult> {
	const key = await cacheKey('search', { ...args });
	const cached = await getCached(env.KV, key);
	if (cached) return ok(cached);

	const wants = (p: string): boolean =>
		args.platform === p || args.platform === 'all' || (args.platform === 'both' && p !== 'youtube');

	const tasks: Array<{ platform: string; run: Promise<SearchResult[]> }> = [];
	if (wants('reddit')) tasks.push({ platform: 'reddit', run: redditSearch(env, args) });
	if (wants('x')) tasks.push({ platform: 'x', run: xSearch(env, args) });
	if (wants('youtube')) tasks.push({ platform: 'youtube', run: youtubeSearch(env, args) });

	const settled = await Promise.allSettled(tasks.map((t) => t.run));
	const results: SearchResult[] = [];
	const failures: string[] = [];
	settled.forEach((s, i) => {
		if (s.status === 'fulfilled') results.push(...s.value);
		else {
			const message = s.reason instanceof Error ? s.reason.message : String(s.reason);
			failures.push(`${tasks[i].platform}: ${message}`);
		}
	});

	if (results.length === 0 && failures.length > 0) {
		return fail(new Error(failures.join(' | ')), 'social_search failed');
	}

	const payload: { results: SearchResult[]; note?: string } = { results };
	if (failures.length > 0) payload.note = `Partial results — ${failures.join(' | ')}`;
	const text = JSON.stringify(payload, null, 1);

	// Cache only complete successes so a provider blip doesn't stick for an hour.
	if (failures.length === 0) await putCached(env.KV, key, text, SEARCH_CACHE_TTL);
	return ok(text);
}

export async function runFindCommunities(
	env: Env,
	args: FindCommunitiesArgs
): Promise<ToolResult> {
	const key = await cacheKey('communities', { ...args });
	const cached = await getCached(env.KV, key);
	if (cached) return ok(cached);

	try {
		const communities = await redditFindCommunities(env, args);
		const text = JSON.stringify({ communities }, null, 1);
		await putCached(env.KV, key, text, COMMUNITY_CACHE_TTL);
		return ok(text);
	} catch (err) {
		return fail(err, 'find_communities failed');
	}
}

export async function runFetchPage(env: Env, args: FetchPageArgs): Promise<ToolResult> {
	const key = await cacheKey('page', { ...args });
	const cached = await getCached(env.KV, key);
	if (cached) return ok(cached);

	try {
		const url = assertPublicHttpsUrl(args.url);

		// A video's content is its transcript, not its player page — checked before
		// the HTML tiers, which would only return chrome.
		let page;
		let tier: string;
		if (isVideoUrl(url)) {
			page = await fetchTranscript(env, url.toString(), { generate: args.generate });
			tier = 'transcript';
		} else {
			// Tier 1 is free; it returns null whenever the page looks blocked, empty,
			// or non-HTML, which is the signal to spend a FireCrawl credit.
			const direct = await directFetch(url);
			page = direct ?? (await firecrawlScrape(env, url.toString()));
			tier = direct ? 'direct' : 'firecrawl';
		}

		const truncated = page.content.length > args.maxChars;
		const payload = {
			url: args.url,
			final_url: page.finalUrl,
			title: page.title,
			status: page.status,
			tier,
			...(page.note ? { note: page.note } : {}),
			...(truncated ? { truncated: true, total_chars: page.content.length } : {}),
			content: truncated ? page.content.slice(0, args.maxChars) + '\n\n… [truncated]' : page.content
		};
		const text = JSON.stringify(payload, null, 1);
		await putCached(env.KV, key, text, PAGE_CACHE_TTL);
		return ok(text);
	} catch (err) {
		return fail(err, 'fetch_page failed');
	}
}

export async function runGetThread(env: Env, args: ThreadArgs): Promise<ToolResult> {
	const key = await cacheKey('thread', { ...args });
	const cached = await getCached(env.KV, key);
	if (cached) return ok(cached);

	try {
		const thread =
			args.platform === 'reddit'
				? await redditThread(env, args)
				: args.platform === 'youtube'
					? await youtubeThread(env, args)
					: await xThread(env, args);
		const text = JSON.stringify(thread, null, 1);
		if (!thread.note) await putCached(env.KV, key, text, THREAD_CACHE_TTL);
		return ok(text);
	} catch (err) {
		return fail(err, 'get_thread failed');
	}
}
