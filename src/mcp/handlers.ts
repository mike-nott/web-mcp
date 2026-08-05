// Rewritten for web-mcp's 2-tool surface; structure follows
// ayima-chat/src/lib/server/mcp/handlers.ts (pure functions returning
// JsonRpcResponse; schema violations -32602, unknown tool -32601).

import type { JsonRpcResponse } from './types';
import { MCP_PROTOCOL_VERSION } from './types';
import { MCP_ERROR_CODES } from './errors';
import type { Capabilities } from '../capabilities';
import { availablePlatforms, availableSearchModes } from '../capabilities';

/** Names the env var a user must set to unlock each platform. */
const PLATFORM_ENV: Record<string, string> = {
	reddit: 'REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET',
	x: 'TWITTERAPI_IO_KEY',
	youtube: 'YOUTUBE_API_KEY'
};

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

export interface WebSearchArgs {
	mode: 'keyword' | 'semantic';
	query?: string;
	similarTo?: string;
	time: string;
	limit: number;
	content: 'highlights' | 'text' | 'none';
	includeDomains?: string[];
	excludeDomains?: string[];
	category?: string;
}

export type ValidatedCall =
	| { ok: true; tool: 'social_search'; args: SearchArgs }
	| { ok: true; tool: 'get_thread'; args: ThreadArgs }
	| { ok: true; tool: 'fetch_page'; args: FetchPageArgs }
	| { ok: true; tool: 'find_communities'; args: FindCommunitiesArgs }
	| { ok: true; tool: 'web_search'; args: WebSearchArgs }
	| { ok: false; code: number; message: string };

// Our tool surface is identical across these revisions, so agreeing with
// whatever the client asked for is both honest and maximally compatible —
// strict clients can reject a version they didn't request.
const KNOWN_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];

export function handleInitialize(
	id: string | number | null,
	requestedVersion?: string
): JsonRpcResponse {
	const protocolVersion =
		requestedVersion && KNOWN_PROTOCOL_VERSIONS.includes(requestedVersion)
			? requestedVersion
			: MCP_PROTOCOL_VERSION;
	return {
		jsonrpc: '2.0',
		id,
		result: {
			protocolVersion,
			capabilities: { tools: { listChanged: false } },
			serverInfo: { name: 'web-mcp', version: '1.0.0' }
		}
	};
}

const SEARCH_DESCRIPTION =
	'Search recent discussions on Reddit, X (Twitter) and YouTube — the practitioner layer that web ' +
	'search cannot reach. This is THE way to search those platforms: reaching for a general web ' +
	'search with a site:reddit.com filter instead gets you second-hand snippets and misses the ' +
	'comments entirely. ' +
	'Returns raw items with engagement signals (score/likes, comment counts, ' +
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

/**
 * Assembled from capabilities: the escalation and transcript sentences only
 * appear when those providers are configured, so the description never promises
 * something this deployment cannot do.
 */
function fetchPageDescription(caps: Capabilities): string {
	const canRead = ['JavaScript-rendered pages that return an empty shell'];
	if (caps.firecrawl) canRead.unshift('sites behind Cloudflare or other bot protection');
	if (caps.firecrawl) canRead.push('PDFs');
	if (caps.transcripts) {
		canRead.push(
			'and video URLs (YouTube, TikTok, Instagram, X), where the content returned is the spoken ' +
				'transcript — the only way to learn what a video actually says'
		);
	}
	const tiers = caps.firecrawl
		? 'The worker tries a free direct fetch first and only escalates to the paid scraping service ' +
			'when the page is genuinely blocked — the "tier" field tells you which path served the result. '
		: 'This server has no bot-protection bypass configured, so pages behind an active challenge ' +
			'will report an error rather than returning content. ';
	return (
		`Read the content of a URL: ${canRead.join(', ')}. ` +
		'Use this whenever your normal web-fetch tool fails, errors, is refused, or returns a ' +
		'challenge/consent page or a near-empty document; it is the fallback, not the first choice. ' +
		'Returns extracted text as markdown plus the final URL, title and HTTP status. ' +
		tiers +
		'If a page cannot be retrieved you get an explicit error rather than the challenge page\'s own ' +
		'HTML, so never treat a failure message as page content. Results are cached for 1 hour.'
	);
}

const FIND_COMMUNITIES_DESCRIPTION =
	'Find the subreddits where a topic is actually discussed. Use this before social_search whenever ' +
	'you are not already confident which community owns a subject — scoping a search to the right ' +
	'subreddit is the single biggest lever on result quality. The intended chain is: ' +
	'find_communities → pick one → social_search scoped to it → get_thread on promising hits. ' +
	'Returns name, subscriber count, and description for each; subscriber count is a rough proxy ' +
	'for whether a community is the main venue for a topic or a small offshoot, though the largest ' +
	'is not always the most specialised — a 30k-member niche subreddit often has better practitioner ' +
	'depth than a 20M general one. ' +
	'IMPORTANT — this matches keywords literally against subreddit names and descriptions; it is NOT ' +
	'semantic. A question or sentence matches almost nothing and silently falls back to merely ' +
	'popular subreddits, which is easy to mistake for a real answer. ' +
	'BAD: "how do I make my house smarter with automation" (returns r/dividends, r/Rabbits, ' +
	'r/HairDye — pure noise). GOOD: "home automation", "smart home". ' +
	'Two or three results is normal and correct for a niche topic — sparse output means the topic is ' +
	'narrow, not that the call failed. If results look off-target, try a different keyword rather ' +
	'than rephrasing into a sentence. Some unrelated matches are expected either way, so judge by ' +
	'the description text. Reddit only. Cached for 24 hours.';

function webSearchDescription(caps: Capabilities): string {
	const both = caps.keyword && caps.exa;
	const parts: string[] = ['Search the open web.'];

	if (both) {
		parts.push(
			'Two engines, chosen with "mode". ' +
				'KEYWORD (the default) is an ordinary search engine over an independent index — use it for ' +
				'factual lookups, news, named things, versions and dates: "python 3.13 release date", ' +
				'"kubernetes 1.32 changelog". ' +
				'SEMANTIC matches MEANING rather than words, so it finds pages whose exact terms you cannot ' +
				'guess: "startups building on-device inference for robotics", "essays arguing against ' +
				'microservices". Reach for semantic when a keyword search would need words you do not have, ' +
				'and for similar_to (find pages like a URL you already have), include/exclude domains at ' +
				'scale, and category filtering.'
		);
	} else if (caps.keyword) {
		parts.push(
			'An ordinary keyword search engine over an independent index — good for factual lookups, ' +
				'news, named things, versions and dates.'
		);
	} else {
		parts.push(
			'Semantic search: this matches MEANING rather than keywords, so describe what you want in ' +
				'natural language — "essays arguing against microservices" — and the exact words need not ' +
				'appear on the page. Also supports similar_to, which finds pages like a URL you already have.'
		);
	}

	if (availablePlatforms(caps).length > 0) {
		// Without this, models reach for a site:reddit.com query here instead of
		// the tool built for it — which returns search-engine snippets rather than
		// the posts and comment trees that are the whole point of this server.
		parts.push(
			'NOT for searching Reddit, X or YouTube — use social_search for those. A site: query here ' +
				'returns second-hand search-engine snippets, while social_search returns the posts ' +
				'themselves with scores, comment counts and dates, and get_thread then gives you the full ' +
				'comment tree. Search engines index that layer poorly or not at all, which is exactly why ' +
				'these tools exist.'
		);
	}

	parts.push(
		'If your client already has its own web search tool, prefer that for trivial factual questions ' +
			'and use this when you need what it cannot do; if it does not, this is your web search. ' +
			'This is NOT for reading a specific known URL — use fetch_page for that. ' +
			'Provide exactly one of query or similar_to. Returns title, url, date and relevant snippets. ' +
			'Cached for 1 hour.'
	);
	return parts.join(' ');
}

export function handleToolsList(
	id: string | number | null,
	caps: Capabilities
): JsonRpcResponse {
	const platforms = availablePlatforms(caps);
	// "both"/"all" only mean anything when there is more than one to combine.
	const searchPlatforms: string[] = [...platforms];
	if (platforms.length > 1) {
		if (caps.reddit && caps.x) searchPlatforms.push('both');
		searchPlatforms.push('all');
	}

	const tools: unknown[] = [];

	if (platforms.length > 0) {
		tools.push({
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
						enum: searchPlatforms,
						description:
							platforms.length > 1
								? 'Where to search. Defaults to the text platforms configured here (Reddit ' +
									'and/or X). "all" adds YouTube — ask for it when video tutorials or talks would ' +
									'help, bearing in mind YouTube search has a much tighter daily quota, which is ' +
									'why it is not in the default.'
								: `Where to search. Only ${platforms[0]} is configured on this server.`
					},
					time: {
						type: 'string',
						enum: ['day', 'week', 'month', 'year', 'all'],
						description: 'Recency window. Default: month — practitioner consensus decays fast.'
					},
					community: {
						type: 'string',
						description:
							"Restrict to one subreddit, e.g. 'StableDiffusion' (Reddit only; ignored elsewhere). " +
							'Strongly recommended — unscoped Reddit search is much noisier.' +
							(caps.reddit
								? ' Call find_communities first if you do not know which subreddit owns the topic.'
								: '')
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
		});

		tools.push({
			name: 'get_thread',
			description: THREAD_DESCRIPTION,
			inputSchema: {
				type: 'object',
				properties: {
					platform: {
						type: 'string',
						enum: platforms,
						description: 'Which platform the id/URL belongs to.'
					},
					id: {
						type: 'string',
						description:
							'Post/tweet/video id from social_search results, or a full URL.'
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
		});
	}

	// Always available: the free direct-fetch tier needs no keys at all.
	tools.push({
		name: 'fetch_page',
		description: fetchPageDescription(caps),
		inputSchema: {
			type: 'object',
			properties: {
				url: { type: 'string', description: 'Full http(s) URL of the page to read.' },
				max_chars: {
					type: 'integer',
					minimum: 1000,
					maximum: 200000,
					description: 'Truncate the returned content to this many characters. Default: 50000.'
				},
				...(caps.transcripts
					? {
							generate: {
								type: 'boolean',
								description:
									'Video URLs only. If the video has no existing captions, generate a transcript ' +
									'with speech recognition. Costs substantially more (billed per minute of video), ' +
									'so only set this after a normal call reports no transcript is available. ' +
									'Default: false.'
							}
						}
					: {})
			},
			required: ['url'],
			additionalProperties: false
		}
	});

	if (caps.reddit) {
		tools.push({
			name: 'find_communities',
			description: FIND_COMMUNITIES_DESCRIPTION,
			inputSchema: {
				type: 'object',
				properties: {
					topic: {
						type: 'string',
						description:
							'Keywords, not a question or sentence — this matches terms literally against ' +
							"subreddit names and descriptions. e.g. 'local llm', 'video generation', 'home automation'."
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
		});
	}

	const searchModes = availableSearchModes(caps);
	if (searchModes.length > 0) {
		tools.push({
			name: 'web_search',
			description: webSearchDescription(caps),
			inputSchema: {
				type: 'object',
				properties: {
					...(searchModes.length > 1
						? {
								mode: {
									type: 'string',
									enum: searchModes,
									description:
										'Which engine to use. "keyword" (default) is an ordinary search engine — ' +
										'best for factual lookups, news and named things. "semantic" matches meaning ' +
										'rather than words, and is required for similar_to.'
								}
							}
						: {}),
					query: {
						type: 'string',
						description:
							'What you are looking for, in natural language — this engine matches meaning, ' +
							'so a full descriptive phrase works better than bare keywords. Omit if using similar_to.'
					},
					similar_to: {
						type: 'string',
						description:
							'A URL to find similar pages to, instead of searching by query. Results from the ' +
							'same domain are excluded automatically. Requires semantic mode. Omit if using query.'
					},
					time: {
						type: 'string',
						enum: ['day', 'week', 'month', 'year', 'all'],
						description:
							'Only return pages published within this window. Default: all — documentation ' +
							'and analysis stay valid, unlike fast-decaying social discussion.'
					},
					limit: {
						type: 'integer',
						minimum: 1,
						maximum: 25,
						description: 'Max results. Default: 10.'
					},
					content: {
						type: 'string',
						enum: ['highlights', 'text', 'none'],
						description:
							'How much page content to return. "highlights" (default) gives short ' +
							'query-relevant excerpts; "text" gives a longer extract per result and costs ' +
							'far more context (semantic mode only — keyword search returns snippets); ' +
							'"none" returns links only.'
					},
					include_domains: {
						type: 'array',
						items: { type: 'string' },
						description:
							"Only return results from these domains, e.g. ['arxiv.org', 'github.com']."
					},
					exclude_domains: {
						type: 'array',
						items: { type: 'string' },
						description:
							'Never return results from these domains — useful for filtering out SEO ' +
							'content farms and vendor marketing.'
					},
					category: {
						type: 'string',
						enum: [
							'company',
							'news',
							'publication',
							'personal site',
							'people',
							'financial report'
						],
						description:
							'Restrict to a type of page. Useful for entity-style research, e.g. category ' +
							'"company" when looking for businesses in a space. Semantic mode only.'
					}
				},
				additionalProperties: false
			}
		});
	}

	return { jsonrpc: '2.0', id, result: { tools } };
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

/** Rejects a platform this deployment has no key for, naming what to set. */
function platformUnavailable(platform: string, caps: Capabilities): ValidatedCall | null {
	const available = availablePlatforms(caps) as string[];
	if (available.includes(platform)) return null;
	return invalid(
		`Platform '${platform}' is not configured on this server — set ${PLATFORM_ENV[platform] ?? 'its API key'} to enable it. ` +
			(available.length
				? `Available: ${available.join(', ')}.`
				: 'No social platforms are currently configured.')
	);
}

export function validateToolCall(params: unknown, caps: Capabilities): ValidatedCall {
	const p = params as { name?: string; arguments?: Record<string, unknown> } | null | undefined;
	const args = p?.arguments ?? {};

	if (p?.name === 'social_search') {
		const query = args.query;
		if (typeof query !== 'string' || !query.trim()) {
			return invalid("'query' is required and must be a non-empty string.");
		}
		// Default to everything configured, rather than a hardcoded reddit+x that
		// would half-fail on a partial install.
		const available = availablePlatforms(caps);
		if (available.length === 0) {
			return invalid(
				'No social platforms are configured on this server. Set REDDIT_CLIENT_ID/' +
					'REDDIT_CLIENT_SECRET, TWITTERAPI_IO_KEY or YOUTUBE_API_KEY to enable social_search.'
			);
		}
		// Default to the cheap, high-volume platforms; YouTube stays opt-in because
		// its search quota is ~90/day while Reddit and X are effectively unlimited.
		const cheap = available.filter((p) => p !== 'youtube');
		const defaultPlatform =
			cheap.length === 2 ? 'both' : cheap.length === 1 ? cheap[0] : available[0];
		const platform = args.platform ?? defaultPlatform;
		if (!isOneOf(platform, ['reddit', 'x', 'youtube', 'both', 'all'] as const)) {
			return invalid("'platform' must be one of: reddit, x, youtube, both, all.");
		}
		if (platform !== 'both' && platform !== 'all') {
			const err = platformUnavailable(platform, caps);
			if (err) return err;
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
		const unavailable = platformUnavailable(platform, caps);
		if (unavailable) return unavailable;
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

	if (p?.name === 'web_search') {
		const modes = availableSearchModes(caps);
		if (modes.length === 0) {
			return invalid(
				'No web search engine is configured on this server. Set TAVILY_API_KEY or ' +
					'BRAVE_API_KEY for keyword search, or EXA_API_KEY for semantic search.'
			);
		}
		const query = args.query;
		const similarTo = args.similar_to;
		const hasQuery = typeof query === 'string' && query.trim().length > 0;
		const hasSimilar = typeof similarTo === 'string' && similarTo.trim().length > 0;
		if (hasQuery === hasSimilar) {
			return invalid(
				hasQuery
					? "Provide either 'query' or 'similar_to', not both."
					: "One of 'query' or 'similar_to' is required."
			);
		}
		if (hasSimilar) {
			try {
				new URL(similarTo as string);
			} catch {
				return invalid("'similar_to' must be a valid URL.");
			}
		}
		// find-similar is an Exa capability; it has no keyword equivalent.
		const requestedMode = args.mode;
		if (requestedMode !== undefined && !isOneOf(requestedMode, ['keyword', 'semantic'] as const)) {
			return invalid("'mode' must be 'keyword' or 'semantic'.");
		}
		const mode = (requestedMode ?? (hasSimilar ? 'semantic' : modes[0])) as
			| 'keyword'
			| 'semantic';
		if (!modes.includes(mode)) {
			return invalid(
				`Search mode '${mode}' is not configured on this server — set ${
					mode === 'keyword' ? 'TAVILY_API_KEY or BRAVE_API_KEY' : 'EXA_API_KEY'
				} to enable it. Available: ${modes.join(', ')}.`
			);
		}
		if (hasSimilar && mode !== 'semantic') {
			return invalid(
				"'similar_to' (find-similar) is only available in semantic mode. Pass mode: 'semantic', " +
					'or use a query instead.'
			);
		}
		const time = args.time ?? 'all';
		if (!isOneOf(time, ['day', 'week', 'month', 'year', 'all'] as const)) {
			return invalid("'time' must be one of: day, week, month, year, all.");
		}
		const content = args.content ?? 'highlights';
		if (!isOneOf(content, ['highlights', 'text', 'none'] as const)) {
			return invalid("'content' must be one of: highlights, text, none.");
		}
		const category = args.category;
		if (category !== undefined && typeof category !== 'string') {
			return invalid("'category' must be a string.");
		}
		const domains = (value: unknown, name: string): string[] | undefined | { error: string } => {
			if (value === undefined) return undefined;
			if (!Array.isArray(value) || value.some((d) => typeof d !== 'string')) {
				return { error: `'${name}' must be an array of domain strings.` };
			}
			return value as string[];
		};
		const include = domains(args.include_domains, 'include_domains');
		if (include && !Array.isArray(include)) return invalid(include.error);
		const exclude = domains(args.exclude_domains, 'exclude_domains');
		if (exclude && !Array.isArray(exclude)) return invalid(exclude.error);

		const rawLimit = args.limit ?? 10;
		if (typeof rawLimit !== 'number' || !Number.isFinite(rawLimit)) {
			return invalid("'limit' must be a number between 1 and 25.");
		}
		return {
			ok: true,
			tool: 'web_search',
			args: {
				mode,
				...(hasQuery ? { query: (query as string).trim() } : {}),
				...(hasSimilar ? { similarTo: (similarTo as string).trim() } : {}),
				time,
				limit: Math.max(1, Math.min(25, Math.floor(rawLimit))),
				content,
				...(Array.isArray(include) ? { includeDomains: include } : {}),
				...(Array.isArray(exclude) ? { excludeDomains: exclude } : {}),
				...(category ? { category } : {})
			}
		};
	}

	return {
		ok: false,
		code: MCP_ERROR_CODES.METHOD_NOT_FOUND,
		message: `Unknown tool: ${p?.name ?? '<missing>'}. This server exposes 'social_search', 'get_thread', 'fetch_page', 'find_communities' and 'web_search'.`
	};
}
