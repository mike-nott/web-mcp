// Rewritten for web-mcp's 2-tool surface; structure follows
// ayima-chat/src/lib/server/mcp/handlers.ts (pure functions returning
// JsonRpcResponse; schema violations -32602, unknown tool -32601).

import type { JsonRpcResponse } from './types';
import { MCP_PROTOCOL_VERSION } from './types';
import { MCP_ERROR_CODES } from './errors';

export interface SearchArgs {
	query: string;
	platform: 'reddit' | 'x' | 'youtube' | 'both' | 'all';
	time: 'day' | 'week' | 'month' | 'year' | 'all';
	community?: string;
	sort: 'relevance' | 'top' | 'new';
	limit: number;
}

export interface ThreadArgs {
	platform: 'reddit' | 'x' | 'youtube';
	id: string;
	sort: 'top' | 'new';
	limit: number;
}

export interface FetchPageArgs {
	url: string;
	maxChars: number;
	generate: boolean;
}

export interface FindCommunitiesArgs {
	topic: string;
	limit: number;
}

export type ValidatedCall =
	| { ok: true; tool: 'social_search'; args: SearchArgs }
	| { ok: true; tool: 'get_thread'; args: ThreadArgs }
	| { ok: true; tool: 'fetch_page'; args: FetchPageArgs }
	| { ok: true; tool: 'find_communities'; args: FindCommunitiesArgs }
	| { ok: false; code: number; message: string };

export function handleInitialize(id: string | number | null): JsonRpcResponse {
	return {
		jsonrpc: '2.0',
		id,
		result: {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: { tools: { listChanged: false } },
			serverInfo: { name: 'web-mcp', version: '1.0.0' }
		}
	};
}

const SEARCH_DESCRIPTION =
	'Search recent discussions on Reddit, X (Twitter) and YouTube — the practitioner layer that web ' +
	'search cannot reach. Returns raw items with engagement signals (score/likes, comment counts, ' +
	'views on YouTube, authors, dates, URLs) for you to weigh yourself: high-scoring posts with many ' +
	'comments indicate community consensus; always follow up with get_thread on promising results, ' +
	'because the real answers (and dissent) live in the comments, not the post. On YouTube, pair a ' +
	'promising video with fetch_page on its URL to read the transcript — the video content itself. ' +
	'IMPORTANT — these platforms use keyword (lexical) matching, NOT semantic search: a ' +
	'natural-language question matches few terms and silently falls back to merely popular posts, ' +
	'so a sentence-shaped query returns unrelated noise. Search like you would a keyword index. ' +
	'BAD: "why do people say ComfyUI video workflows are slow". ' +
	'GOOD: "comfyui video workflow slow" (keywords), or "wan 2.2" (quoted exact phrase). ' +
	'Scope to a community whenever you can — it is the single biggest quality lever. If you do not ' +
	'know the right subreddit, run one unscoped keyword search, read the "community" field on the ' +
	'results to learn where the topic actually lives, then search again scoped to it. ' +
	"X extras: 'from:user', 'min_faves:100' (quality floor), 'since:2026-07-01'. " +
	'YouTube search is quota-limited to roughly 90 calls per day, so prefer one good query over ' +
	'several speculative ones there. Results are cached for 1 hour.';

const THREAD_DESCRIPTION =
	'Fetch a full discussion thread with its scored comment/reply tree — use after social_search to ' +
	'read what practitioners actually said. Returns the post plus comments with scores, authors and ' +
	'dates (Reddit comments are nested with a depth field; X replies and YouTube comments are flat). ' +
	'Sort "top" surfaces the community-endorsed answers; note high-scoring dissenting comments — they ' +
	'are signal, not noise. On YouTube this returns the video metadata plus its top comments, which ' +
	'often contain corrections and real-world results the video itself omits; use fetch_page on the ' +
	'video URL to read what was actually said. Accepts a bare post/tweet/video id or a full URL. ' +
	'Results are cached for 15 minutes.';

const FETCH_PAGE_DESCRIPTION =
	'Read the content of any URL that ordinary fetching cannot reach — sites behind Cloudflare or ' +
	'other bot protection, JavaScript-rendered pages that return an empty shell, PDFs, and video ' +
	'URLs (YouTube, TikTok, Instagram, X), where the content returned is the spoken transcript. ' +
	'Reading a video transcript is the only way to learn what a video actually says. Use this whenever ' +
	'your normal web-fetch tool fails, errors, is refused, or returns a challenge/consent page or a ' +
	'near-empty document; it is the fallback, not the first choice. Returns extracted text as ' +
	'markdown plus the final URL, title and HTTP status. The worker tries a free direct fetch first ' +
	'and only escalates to the paid scraping service when the page is genuinely blocked — the ' +
	'"tier" field tells you which path served the result. If a page cannot be retrieved you get an ' +
	'explicit error rather than the challenge page\'s own HTML, so never treat a failure message as ' +
	'page content. Results are cached for 1 hour.';

const FIND_COMMUNITIES_DESCRIPTION =
	'Find the subreddits where a topic is actually discussed. Use this before social_search whenever ' +
	'you are not already confident which community owns a subject — scoping a search to the right ' +
	'subreddit is the single biggest lever on result quality. The intended chain is: ' +
	'find_communities → pick one → social_search scoped to it → get_thread on promising hits. ' +
	'Returns name, subscriber count, and description for each; subscriber count is a rough proxy ' +
	'for whether a community is the main venue for a topic or a small offshoot, though the largest ' +
	'is not always the most specialised — a 30k-member niche subreddit often has better practitioner ' +
	'depth than a 20M general one. Matches on both names and descriptions, so expect some unrelated ' +
	'results and judge by the description. Reddit only. Cached for 24 hours.';

export function handleToolsList(id: string | number | null): JsonRpcResponse {
	return {
		jsonrpc: '2.0',
		id,
		result: {
			tools: [
				{
					name: 'social_search',
					description: SEARCH_DESCRIPTION,
					inputSchema: {
						type: 'object',
						properties: {
							query: {
								type: 'string',
								description:
									'Keywords, not a question or sentence — these engines match terms literally. ' +
									'Quote phrases for exact matching. Platform-native operators pass through unchanged.'
							},
							platform: {
								type: 'string',
								enum: ['reddit', 'x', 'youtube', 'both', 'all'],
								description:
									'Where to search. "both" = Reddit + X (the default). "all" adds YouTube — ' +
									'use it when video tutorials or talks would help, bearing in mind YouTube ' +
									'search has a much tighter daily quota.'
							},
							time: {
								type: 'string',
								enum: ['day', 'week', 'month', 'year', 'all'],
								description:
									'Recency window. Default: month — practitioner consensus decays fast.'
							},
							community: {
								type: 'string',
								description:
									"Restrict to one subreddit, e.g. 'StableDiffusion' (Reddit only; ignored for X). " +
									'Strongly recommended — unscoped Reddit search is much noisier. Call ' +
									'find_communities first if you do not know which subreddit owns the topic.'
							},
							sort: {
								type: 'string',
								enum: ['relevance', 'top', 'new'],
								description: 'Result ordering. Default: relevance.'
							},
							limit: {
								type: 'integer',
								minimum: 1,
								maximum: 25,
								description: 'Max results per platform. Default: 10.'
							}
						},
						required: ['query'],
						additionalProperties: false
					}
				},
				{
					name: 'get_thread',
					description: THREAD_DESCRIPTION,
					inputSchema: {
						type: 'object',
						properties: {
							platform: {
								type: 'string',
								enum: ['reddit', 'x', 'youtube'],
								description: 'Which platform the id/URL belongs to.'
							},
							id: {
								type: 'string',
								description:
									"Post/tweet id from social_search results, or a full URL (reddit.com/.../comments/<id>/... or x.com/.../status/<id>)."
							},
							sort: {
								type: 'string',
								enum: ['top', 'new'],
								description: 'Comment ordering. Default: top.'
							},
							limit: {
								type: 'integer',
								minimum: 1,
								maximum: 100,
								description: 'Max comments/replies returned. Default: 30.'
							}
						},
						required: ['platform', 'id'],
						additionalProperties: false
					}
				},
				{
					name: 'fetch_page',
					description: FETCH_PAGE_DESCRIPTION,
					inputSchema: {
						type: 'object',
						properties: {
							url: {
								type: 'string',
								description: 'Full http(s) URL of the page to read.'
							},
							max_chars: {
								type: 'integer',
								minimum: 1000,
								maximum: 200000,
								description:
									'Truncate the returned content to this many characters. Default: 50000.'
							},
							generate: {
								type: 'boolean',
								description:
									'Video URLs only. If the video has no existing captions, generate a transcript ' +
									'with speech recognition. Costs substantially more (billed per minute of video), ' +
									'so only set this after a normal call reports no transcript is available. ' +
									'Default: false.'
							}
						},
						required: ['url'],
						additionalProperties: false
					}
				},
				{
					name: 'find_communities',
					description: FIND_COMMUNITIES_DESCRIPTION,
					inputSchema: {
						type: 'object',
						properties: {
							topic: {
								type: 'string',
								description:
									"Keywords describing the subject, e.g. 'local llm', 'video generation'."
							},
							limit: {
								type: 'integer',
								minimum: 1,
								maximum: 25,
								description: 'Max communities returned. Default: 10.'
							}
						},
						required: ['topic'],
						additionalProperties: false
					}
				}
			]
		}
	};
}

function extractId(platform: 'reddit' | 'x' | 'youtube', raw: string): string | null {
	const value = raw.trim();
	if (!value.includes('/')) return value;
	if (platform === 'reddit') {
		const m = value.match(/\/comments\/([a-z0-9]+)/i);
		return m ? m[1] : null;
	}
	if (platform === 'youtube') {
		// watch?v=ID, youtu.be/ID, /shorts/ID, /live/ID
		const m =
			value.match(/[?&]v=([\w-]{6,})/) ??
			value.match(/youtu\.be\/([\w-]{6,})/) ??
			value.match(/\/(?:shorts|live|embed)\/([\w-]{6,})/);
		return m ? m[1] : null;
	}
	const m = value.match(/\/status(?:es)?\/(\d+)/);
	return m ? m[1] : null;
}

function invalid(message: string): ValidatedCall {
	return { ok: false, code: MCP_ERROR_CODES.INVALID_PARAMS, message };
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
	return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

export function validateToolCall(params: unknown): ValidatedCall {
	const p = params as { name?: string; arguments?: Record<string, unknown> } | null | undefined;
	const args = p?.arguments ?? {};

	if (p?.name === 'social_search') {
		const query = args.query;
		if (typeof query !== 'string' || !query.trim()) {
			return invalid("'query' is required and must be a non-empty string.");
		}
		const platform = args.platform ?? 'both';
		if (!isOneOf(platform, ['reddit', 'x', 'youtube', 'both', 'all'] as const)) {
			return invalid("'platform' must be one of: reddit, x, youtube, both, all.");
		}
		const time = args.time ?? 'month';
		if (!isOneOf(time, ['day', 'week', 'month', 'year', 'all'] as const)) {
			return invalid("'time' must be one of: day, week, month, year, all.");
		}
		const sort = args.sort ?? 'relevance';
		if (!isOneOf(sort, ['relevance', 'top', 'new'] as const)) {
			return invalid("'sort' must be one of: relevance, top, new.");
		}
		const community = args.community;
		if (community !== undefined && typeof community !== 'string') {
			return invalid("'community' must be a string subreddit name.");
		}
		const rawLimit = args.limit ?? 10;
		if (typeof rawLimit !== 'number' || !Number.isFinite(rawLimit)) {
			return invalid("'limit' must be a number between 1 and 25.");
		}
		const limit = Math.max(1, Math.min(25, Math.floor(rawLimit)));
		return {
			ok: true,
			tool: 'social_search',
			args: { query: query.trim(), platform, time, community, sort, limit }
		};
	}

	if (p?.name === 'get_thread') {
		const platform = args.platform;
		if (!isOneOf(platform, ['reddit', 'x', 'youtube'] as const)) {
			return invalid("'platform' must be 'reddit', 'x' or 'youtube'.");
		}
		const rawId = args.id;
		if (typeof rawId !== 'string' || !rawId.trim()) {
			return invalid("'id' is required — a post/tweet id or full URL.");
		}
		const id = extractId(platform, rawId);
		if (!id) {
			return invalid(
				`Could not extract a ${platform} id from '${rawId}'. Pass a bare id or a full post/tweet URL.`
			);
		}
		const sort = args.sort ?? 'top';
		if (!isOneOf(sort, ['top', 'new'] as const)) {
			return invalid("'sort' must be 'top' or 'new'.");
		}
		const rawLimit = args.limit ?? 30;
		if (typeof rawLimit !== 'number' || !Number.isFinite(rawLimit)) {
			return invalid("'limit' must be a number between 1 and 100.");
		}
		const limit = Math.max(1, Math.min(100, Math.floor(rawLimit)));
		return { ok: true, tool: 'get_thread', args: { platform, id, sort, limit } };
	}

	if (p?.name === 'fetch_page') {
		const url = args.url;
		if (typeof url !== 'string' || !url.trim()) {
			return invalid("'url' is required and must be a non-empty string.");
		}
		const rawMax = args.max_chars ?? 50000;
		if (typeof rawMax !== 'number' || !Number.isFinite(rawMax)) {
			return invalid("'max_chars' must be a number between 1000 and 200000.");
		}
		const maxChars = Math.max(1000, Math.min(200000, Math.floor(rawMax)));
		const generate = args.generate;
		if (generate !== undefined && typeof generate !== 'boolean') {
			return invalid("'generate' must be a boolean.");
		}
		return {
			ok: true,
			tool: 'fetch_page',
			args: { url: url.trim(), maxChars, generate: generate === true }
		};
	}

	if (p?.name === 'find_communities') {
		const topic = args.topic;
		if (typeof topic !== 'string' || !topic.trim()) {
			return invalid("'topic' is required and must be a non-empty string.");
		}
		const rawLimit = args.limit ?? 10;
		if (typeof rawLimit !== 'number' || !Number.isFinite(rawLimit)) {
			return invalid("'limit' must be a number between 1 and 25.");
		}
		const limit = Math.max(1, Math.min(25, Math.floor(rawLimit)));
		return { ok: true, tool: 'find_communities', args: { topic: topic.trim(), limit } };
	}

	return {
		ok: false,
		code: MCP_ERROR_CODES.METHOD_NOT_FOUND,
		message: `Unknown tool: ${p?.name ?? '<missing>'}. This server exposes 'social_search', 'get_thread', 'fetch_page' and 'find_communities'.`
	};
}
