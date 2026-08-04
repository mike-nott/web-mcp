// Rewritten for web-mcp's 2-tool surface; structure follows
// ayima-chat/src/lib/server/mcp/handlers.ts (pure functions returning
// JsonRpcResponse; schema violations -32602, unknown tool -32601).

import type { JsonRpcResponse } from './types';
import { MCP_PROTOCOL_VERSION } from './types';
import { MCP_ERROR_CODES } from './errors';

export interface SearchArgs {
	query: string;
	platform: 'reddit' | 'x' | 'both';
	time: 'day' | 'week' | 'month' | 'year' | 'all';
	community?: string;
	sort: 'relevance' | 'top' | 'new';
	limit: number;
}

export interface ThreadArgs {
	platform: 'reddit' | 'x';
	id: string;
	sort: 'top' | 'new';
	limit: number;
}

export type ValidatedCall =
	| { ok: true; tool: 'social_search'; args: SearchArgs }
	| { ok: true; tool: 'get_thread'; args: ThreadArgs }
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
	'Search recent discussions on Reddit and X (Twitter) — the practitioner layer that web search ' +
	'cannot reach. Returns raw posts with engagement signals (score/likes, comment counts, authors, ' +
	'dates, URLs) for you to weigh yourself: high-scoring posts with many comments indicate ' +
	'community consensus; always follow up with get_thread on promising results, because the real ' +
	'answers (and dissent) live in the comments, not the post. Native platform search operators ' +
	"pass through in the query — Reddit: standard keyword search; X: 'from:user', 'min_faves:100', " +
	"'since:2026-07-01', quoted phrases. Results are cached for 1 hour.";

const THREAD_DESCRIPTION =
	'Fetch a full discussion thread with its scored comment/reply tree — use after social_search to ' +
	'read what practitioners actually said. Returns the post plus comments with scores, authors and ' +
	'dates (Reddit comments are nested with a depth field; X replies are flat). Sort "top" surfaces ' +
	'the community-endorsed answers; note high-scoring dissenting comments — they are signal, not ' +
	'noise. Accepts a bare post/tweet id or a full URL. Results are cached for 15 minutes.';

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
									'Search terms. Platform-native operators pass through unchanged.'
							},
							platform: {
								type: 'string',
								enum: ['reddit', 'x', 'both'],
								description: 'Where to search. Default: both.'
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
									"Restrict to one subreddit, e.g. 'StableDiffusion' (Reddit only; ignored for X)."
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
								enum: ['reddit', 'x'],
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
				}
			]
		}
	};
}

function extractId(platform: 'reddit' | 'x', raw: string): string | null {
	const value = raw.trim();
	if (!value.includes('/')) return value;
	if (platform === 'reddit') {
		const m = value.match(/\/comments\/([a-z0-9]+)/i);
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
		if (!isOneOf(platform, ['reddit', 'x', 'both'] as const)) {
			return invalid("'platform' must be one of: reddit, x, both.");
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
		if (!isOneOf(platform, ['reddit', 'x'] as const)) {
			return invalid("'platform' must be 'reddit' or 'x'.");
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

	return {
		ok: false,
		code: MCP_ERROR_CODES.METHOD_NOT_FOUND,
		message: `Unknown tool: ${p?.name ?? '<missing>'}. This server exposes 'social_search' and 'get_thread'.`
	};
}
