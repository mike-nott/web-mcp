// Which providers this deployment actually has keys for.
//
// Every provider is independently optional — MCP_AUTH_TOKEN is the only
// required secret. Capabilities are detected per request and used to build the
// tools/list response, so a client is never offered a tool that cannot work.

import type { Env } from './env';

export interface Capabilities {
	reddit: boolean;
	x: boolean;
	youtube: boolean;
	/** Video transcripts via Supadata. */
	transcripts: boolean;
	/** Escalation for bot-protected pages via FireCrawl. */
	firecrawl: boolean;
	exa: boolean;
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
		exa: set(env.EXA_API_KEY)
	};
}

/** Social platforms available for search/threads, in preference order. */
export function availablePlatforms(caps: Capabilities): Array<'reddit' | 'x' | 'youtube'> {
	const list: Array<'reddit' | 'x' | 'youtube'> = [];
	if (caps.reddit) list.push('reddit');
	if (caps.x) list.push('x');
	if (caps.youtube) list.push('youtube');
	return list;
}
