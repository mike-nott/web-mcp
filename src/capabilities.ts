// Which providers this deployment actually has keys for.
//
// Every provider is independently optional — MCP_AUTH_TOKEN is the only
// required secret. Capabilities are detected per request and used to build the
// tools/list response, so a client is never offered a tool that cannot work.

import type { Env } from './env';
import { resolveKeywordEngine } from './providers/keyword';

export interface Capabilities {
	reddit: boolean;
	x: boolean;
	youtube: boolean;
	/** Video transcripts via Supadata. */
	transcripts: boolean;
	/** Escalation for bot-protected pages via FireCrawl. */
	firecrawl: boolean;
	/** Semantic search + find-similar. */
	exa: boolean;
	/** Keyword web search engines. */
	brave: boolean;
	tavily: boolean;
	/** True when either keyword engine is usable under the current preference. */
	keyword: boolean;
}

/** Treats empty/whitespace as unset, so a blank var behaves like a missing one. */
function set(value: string | undefined): boolean {
	return typeof value === 'string' && value.trim().length > 0;
}

export function detectCapabilities(env: Env): Capabilities {
	return {
		reddit: set(env.REDDIT_CLIENT_ID) && set(env.REDDIT_CLIENT_SECRET),
		x: set(env.TWITTERAPI_IO_KEY),
		youtube: set(env.YOUTUBE_API_KEY),
		transcripts: set(env.SUPADATA_API_KEY),
		firecrawl: set(env.FIRECRAWL_API_KEY),
		exa: set(env.EXA_API_KEY),
		brave: set(env.BRAVE_API_KEY),
		tavily: set(env.TAVILY_API_KEY),
		// Respects KEYWORD_SEARCH_PROVIDER: forcing an engine whose key is
		// missing means keyword search is genuinely unavailable, not silently
		// served by the other one.
		keyword: resolveKeywordEngine(env) !== null
	};
}

/** Search modes available on web_search, in default-preference order. */
export function availableSearchModes(caps: Capabilities): Array<'keyword' | 'semantic'> {
	const modes: Array<'keyword' | 'semantic'> = [];
	if (caps.keyword) modes.push('keyword');
	if (caps.exa) modes.push('semantic');
	return modes;
}

/** Social platforms available for search/threads, in preference order. */
export function availablePlatforms(caps: Capabilities): Array<'reddit' | 'x' | 'youtube'> {
	const list: Array<'reddit' | 'x' | 'youtube'> = [];
	if (caps.reddit) list.push('reddit');
	if (caps.x) list.push('x');
	if (caps.youtube) list.push('youtube');
	return list;
}
