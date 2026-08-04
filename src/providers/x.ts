// X provider — TwitterAPI.io REST (third-party, ~$0.15/1k tweets). Endpoints
// verified live 2026-08-04: advanced_search (full X search operators inline in
// the query, e.g. min_faves:200, from:user, since:YYYY-MM-DD), tweet/replies.
// Every upstream call consumes the daily X budget.

import type { Env } from '../env';
import { consumeBudget } from '../budget';
import { ProviderError } from './errors';
import type { SearchResult, Thread, ThreadComment } from './reddit';

const BASE = 'https://api.twitterapi.io';

interface Tweet {
	id: string;
	text: string;
	url?: string;
	likeCount?: number;
	retweetCount?: number;
	replyCount?: number;
	createdAt?: string;
	author?: { userName?: string };
}

async function xGet(env: Env, path: string): Promise<unknown> {
	await consumeBudget(env, 'x');
	const res = await fetch(`${BASE}${path}`, {
		headers: { 'x-api-key': env.TWITTERAPI_IO_KEY }
	});
	if (res.status === 429) {
		throw new ProviderError('TwitterAPI.io rate limit hit — retry shortly.');
	}
	if (!res.ok) throw new ProviderError(`TwitterAPI.io error (HTTP ${res.status}) on ${path}`);
	const data = (await res.json()) as Record<string, unknown>;
	if (typeof data.error === 'string' || typeof data.error === 'number') {
		throw new ProviderError(`TwitterAPI.io error: ${data.message ?? data.error}`);
	}
	return data;
}

function toDate(createdAt: string | undefined): string {
	if (!createdAt) return '';
	const d = new Date(createdAt);
	return Number.isNaN(d.getTime()) ? createdAt : d.toISOString().slice(0, 10);
}

function mapTweet(t: Tweet): SearchResult {
	const author = t.author?.userName ?? '?';
	return {
		platform: 'x',
		id: t.id,
		text: t.text?.trim() ?? '',
		score: t.likeCount ?? 0,
		comments: t.replyCount ?? 0,
		author: `@${author}`,
		date: toDate(t.createdAt),
		url: t.url ?? `https://x.com/${author}/status/${t.id}`
	};
}

function sinceDate(time: string): string | null {
	const days: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
	const n = days[time];
	if (!n) return null;
	return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

export async function xSearch(
	env: Env,
	opts: { query: string; time: string; sort: string; limit: number }
): Promise<SearchResult[]> {
	const since = sinceDate(opts.time);
	// Only add since: when the caller didn't already scope time via operators.
	const query =
		since && !/\b(since|until|within_time):/.test(opts.query)
			? `${opts.query} since:${since}`
			: opts.query;
	const queryType = opts.sort === 'new' ? 'Latest' : 'Top';
	const params = new URLSearchParams({ query, queryType });
	const data = (await xGet(env, `/twitter/tweet/advanced_search?${params}`)) as {
		tweets?: Tweet[];
	};
	return (data.tweets ?? []).slice(0, opts.limit).map(mapTweet);
}

export async function xThread(
	env: Env,
	opts: { id: string; sort: string; limit: number }
): Promise<Thread> {
	// Original tweet and its replies are separate endpoints; the replies still
	// have value if the original fetch fails, so tolerate that half breaking.
	const [postResult, repliesResult] = await Promise.allSettled([
		xGet(env, `/twitter/tweets?tweet_ids=${encodeURIComponent(opts.id)}`),
		xGet(env, `/twitter/tweet/replies?tweetId=${encodeURIComponent(opts.id)}`)
	]);

	let post: SearchResult | null = null;
	if (postResult.status === 'fulfilled') {
		const tweets = (postResult.value as { tweets?: Tweet[] }).tweets ?? [];
		if (tweets[0]) post = mapTweet(tweets[0]);
	}

	if (repliesResult.status === 'rejected' && !post) {
		throw new ProviderError(`Could not fetch tweet '${opts.id}' or its replies`);
	}

	let replies: ThreadComment[] = [];
	if (repliesResult.status === 'fulfilled') {
		const raw = repliesResult.value as { tweets?: Tweet[]; replies?: Tweet[] };
		const list = raw.tweets ?? raw.replies ?? [];
		const sorted =
			opts.sort === 'new'
				? [...list].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
				: [...list].sort((a, b) => (b.likeCount ?? 0) - (a.likeCount ?? 0));
		replies = sorted.slice(0, opts.limit).map((t) => ({
			score: t.likeCount ?? 0,
			author: `@${t.author?.userName ?? '?'}`,
			date: toDate(t.createdAt),
			depth: 0,
			text: t.text?.trim() ?? ''
		}));
	}

	const base: Thread = post
		? { ...post, replies }
		: {
				platform: 'x',
				id: opts.id,
				text: '',
				score: 0,
				comments: replies.length,
				author: '',
				date: '',
				url: `https://x.com/i/status/${opts.id}`,
				replies,
				note: 'Original tweet could not be fetched; showing replies only.'
			};
	return base;
}
