// Reddit provider — official Data API, app-only OAuth (client_credentials).
// Endpoints verified live 2026-08-04: token, /search, /r/{sub}/search,
// /comments/{id}. Free tier: 1000 req/10min; Reddit requires a descriptive UA
// and OAuth for all datacenter-IP traffic.

import type { Env } from '../env';
import { ProviderError } from './errors';
import type { SearchResult, Thread, ThreadComment } from './types';

const TOKEN_KEY = 'reddit:token';
const TOKEN_TTL_SECONDS = 3300; // Reddit tokens last 60min; refresh at 55

async function getToken(env: Env): Promise<string> {
	if (!env.REDDIT_CLIENT_ID || !env.REDDIT_CLIENT_SECRET) {
		throw new ProviderError(
			'Reddit is not configured on this server — set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET.'
		);
	}
	const cached = await env.KV.get(TOKEN_KEY);
	if (cached) return cached;
	const res = await fetch('https://www.reddit.com/api/v1/access_token', {
		method: 'POST',
		headers: {
			Authorization: 'Basic ' + btoa(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`),
			'Content-Type': 'application/x-www-form-urlencoded',
			'User-Agent': env.REDDIT_USER_AGENT
		},
		body: 'grant_type=client_credentials'
	});
	if (!res.ok) throw new ProviderError(`Reddit token request failed (HTTP ${res.status})`);
	const data = (await res.json()) as { access_token?: string };
	if (!data.access_token) throw new ProviderError('Reddit token response missing access_token');
	await env.KV.put(TOKEN_KEY, data.access_token, { expirationTtl: TOKEN_TTL_SECONDS });
	return data.access_token;
}

async function redditGet(env: Env, path: string, retried = false): Promise<unknown> {
	const token = await getToken(env);
	const res = await fetch(`https://oauth.reddit.com${path}`, {
		headers: { Authorization: `Bearer ${token}`, 'User-Agent': env.REDDIT_USER_AGENT }
	});
	if (res.status === 401 && !retried) {
		// Token expired or revoked early — drop the cache and retry once.
		await env.KV.delete(TOKEN_KEY);
		return redditGet(env, path, true);
	}
	if (res.status === 429) {
		throw new ProviderError('Reddit rate limit hit (1000 req/10min) — retry in a few minutes.');
	}
	if (!res.ok) throw new ProviderError(`Reddit API error (HTTP ${res.status}) on ${path}`);
	const remaining = Number.parseFloat(res.headers.get('x-ratelimit-remaining') ?? '999');
	if (remaining < 5) {
		const reset = res.headers.get('x-ratelimit-reset') ?? '?';
		throw new ProviderError(
			`Reddit rate limit nearly exhausted (${remaining} left, resets in ${reset}s) — backing off.`
		);
	}
	return res.json();
}

function trim(text: string, max: number): string {
	const clean = text.trim();
	return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

interface RedditPost {
	id: string;
	title: string;
	selftext?: string;
	score: number;
	num_comments: number;
	author: string;
	created_utc: number;
	permalink: string;
	subreddit: string;
}

function mapPost(p: RedditPost, textMax: number): SearchResult {
	return {
		platform: 'reddit',
		id: p.id,
		title: p.title,
		text: trim(p.selftext ?? '', textMax),
		score: p.score,
		comments: p.num_comments,
		author: p.author,
		date: new Date(p.created_utc * 1000).toISOString().slice(0, 10),
		url: `https://www.reddit.com${p.permalink}`,
		community: `r/${p.subreddit}`
	};
}

export async function redditSearch(
	env: Env,
	opts: { query: string; time: string; community?: string; sort: string; limit: number }
): Promise<SearchResult[]> {
	const params = new URLSearchParams({
		q: opts.query,
		sort: opts.sort,
		t: opts.time,
		limit: String(opts.limit),
		raw_json: '1'
	});
	let path: string;
	if (opts.community) {
		params.set('restrict_sr', '1');
		path = `/r/${encodeURIComponent(opts.community.replace(/^r\//, ''))}/search?${params}`;
	} else {
		path = `/search?${params}`;
	}
	const data = (await redditGet(env, path)) as {
		data?: { children?: Array<{ kind: string; data: RedditPost }> };
	};
	return (data.data?.children ?? [])
		.filter((c) => c.kind === 't3')
		.map((c) => mapPost(c.data, 300));
}

export interface Community {
	name: string;
	subscribers: number;
	description: string;
	url: string;
	over18: boolean;
}

interface RedditSubreddit {
	display_name: string;
	subscribers?: number;
	public_description?: string;
	over18?: boolean;
}

/**
 * Finds subreddits by topic. Uses /subreddits/search rather than
 * /api/subreddit_autocomplete_v2 because the latter matches names only — for
 * "local llm" it misses r/LocalLLaMA (792k members, the actual home of the
 * topic) while this endpoint searches descriptions and surfaces it.
 *
 * Results are returned in Reddit's own relevance order with subscriber counts
 * attached; the calling model does the picking, the worker does not re-rank.
 */
export async function redditFindCommunities(
	env: Env,
	opts: { topic: string; limit: number }
): Promise<Community[]> {
	const params = new URLSearchParams({
		q: opts.topic,
		limit: String(opts.limit),
		include_over_18: 'false',
		raw_json: '1'
	});
	const data = (await redditGet(env, `/subreddits/search?${params}`)) as {
		data?: { children?: Array<{ kind: string; data: RedditSubreddit }> };
	};
	return (data.data?.children ?? [])
		.filter((c) => c.kind === 't5')
		.map((c) => ({
			name: `r/${c.data.display_name}`,
			subscribers: c.data.subscribers ?? 0,
			description: trim(c.data.public_description ?? '', 200),
			url: `https://www.reddit.com/r/${c.data.display_name}/`,
			over18: c.data.over18 ?? false
		}));
}

interface RedditComment {
	id: string;
	author: string;
	body: string;
	score: number;
	created_utc: number;
	replies?: '' | { data?: { children?: RedditCommentNode[] } };
}

interface RedditCommentNode {
	kind: string;
	data: RedditComment;
}

function flattenComments(
	nodes: RedditCommentNode[],
	depth: number,
	out: ThreadComment[],
	limit: number
): void {
	for (const node of nodes) {
		if (out.length >= limit) return;
		if (node.kind !== 't1') continue; // skip 'more' stubs
		const c = node.data;
		out.push({
			score: c.score,
			author: c.author,
			date: new Date(c.created_utc * 1000).toISOString().slice(0, 10),
			depth,
			text: trim(c.body, 600)
		});
		const children =
			typeof c.replies === 'object' ? (c.replies?.data?.children ?? []) : [];
		flattenComments(children, depth + 1, out, limit);
	}
}

export async function redditThread(
	env: Env,
	opts: { id: string; sort: string; limit: number }
): Promise<Thread> {
	const sort = opts.sort === 'new' ? 'new' : 'top';
	const path = `/comments/${encodeURIComponent(opts.id)}?sort=${sort}&depth=6&limit=${Math.min(
		opts.limit * 2,
		200
	)}&raw_json=1`;
	const data = (await redditGet(env, path)) as Array<{
		data?: { children?: Array<{ kind: string; data: unknown }> };
	}>;
	const postNode = data[0]?.data?.children?.find((c) => c.kind === 't3');
	if (!postNode) throw new ProviderError(`Reddit post '${opts.id}' not found`);
	const post = mapPost(postNode.data as RedditPost, 2000);
	const replies: ThreadComment[] = [];
	flattenComments(
		(data[1]?.data?.children ?? []) as RedditCommentNode[],
		0,
		replies,
		opts.limit
	);
	return { ...post, replies };
}
