// YouTube provider — official Data API v3, API-key auth (no OAuth needed for
// public read).
//
// Quota shape drives the design: search.list sits in its own bucket capped at
// ~100 calls/day, while videos.list and commentThreads.list cost 1 unit against
// the 10,000/day pool — effectively unlimited. So only discovery is scarce, and
// only search.list consumes the budget counter.
//
// search.list also returns NO statistics (no views, likes or comment counts),
// so every search is followed by one batched videos.list covering up to 50 ids
// for a single unit.

import type { Env } from '../env';
import { consumeBudget } from '../budget';
import { ProviderError } from './errors';
import type { SearchResult, Thread, ThreadComment } from './types';

const API_BASE = 'https://www.googleapis.com/youtube/v3';

interface SearchItem {
	id?: { videoId?: string };
	snippet?: {
		title?: string;
		description?: string;
		channelTitle?: string;
		publishedAt?: string;
	};
}

interface VideoItem {
	id?: string;
	snippet?: {
		title?: string;
		description?: string;
		channelTitle?: string;
		publishedAt?: string;
	};
	statistics?: {
		viewCount?: string;
		likeCount?: string;
		commentCount?: string;
	};
}

async function ytGet(env: Env, path: string, params: URLSearchParams): Promise<unknown> {
	if (!env.YOUTUBE_API_KEY) {
		throw new ProviderError('YOUTUBE_API_KEY is not configured, so YouTube is unavailable.');
	}
	params.set('key', env.YOUTUBE_API_KEY);
	const res = await fetch(`${API_BASE}/${path}?${params}`);
	if (!res.ok) {
		const body = await res.text();
		if (res.status === 403 && body.includes('quotaExceeded')) {
			throw new ProviderError(
				"YouTube API daily quota exceeded (Google's own limit, separate from this server's budget). " +
					'It resets at midnight Pacific. Video metadata, comments and transcripts may also be affected.'
			);
		}
		if (res.status === 403) {
			throw new ProviderError(
				`YouTube API access denied — check the API key is valid and the YouTube Data API v3 is enabled. (${body.slice(0, 150)})`
			);
		}
		throw new ProviderError(`YouTube API error (${res.status}): ${body.slice(0, 200)}`);
	}
	return res.json();
}

function toInt(value: string | undefined): number {
	const n = Number.parseInt(value ?? '0', 10);
	return Number.isFinite(n) ? n : 0;
}

function trim(text: string, max: number): string {
	const clean = text.trim();
	return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

function publishedAfter(time: string): string | null {
	const days: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
	const n = days[time];
	return n ? new Date(Date.now() - n * 86400000).toISOString() : null;
}

function mapVideo(v: VideoItem, textMax: number): SearchResult {
	const id = v.id ?? '';
	return {
		platform: 'youtube',
		id,
		title: v.snippet?.title ?? '',
		text: trim(v.snippet?.description ?? '', textMax),
		score: toInt(v.statistics?.likeCount),
		comments: toInt(v.statistics?.commentCount),
		views: toInt(v.statistics?.viewCount),
		author: v.snippet?.channelTitle ?? '',
		date: (v.snippet?.publishedAt ?? '').slice(0, 10),
		url: `https://www.youtube.com/watch?v=${id}`,
		community: v.snippet?.channelTitle
	};
}

/** Batched videos.list — up to 50 ids for a single quota unit. */
async function fetchVideos(env: Env, ids: string[], textMax: number): Promise<SearchResult[]> {
	if (ids.length === 0) return [];
	const params = new URLSearchParams({
		part: 'snippet,statistics',
		id: ids.slice(0, 50).join(',')
	});
	const data = (await ytGet(env, 'videos', params)) as { items?: VideoItem[] };
	return (data.items ?? []).map((v) => mapVideo(v, textMax));
}

export async function youtubeSearch(
	env: Env,
	opts: { query: string; time: string; sort: string; limit: number }
): Promise<SearchResult[]> {
	await consumeBudget(env, 'youtube_search');

	const order = opts.sort === 'new' ? 'date' : opts.sort === 'top' ? 'viewCount' : 'relevance';
	const params = new URLSearchParams({
		part: 'snippet',
		type: 'video',
		q: opts.query,
		order,
		maxResults: String(Math.min(opts.limit, 50))
	});
	const after = publishedAfter(opts.time);
	if (after) params.set('publishedAfter', after);

	const data = (await ytGet(env, 'search', params)) as { items?: SearchItem[] };
	const ids = (data.items ?? []).map((i) => i.id?.videoId).filter((id): id is string => !!id);
	if (ids.length === 0) return [];

	// Enrich with statistics — search.list omits them entirely.
	const enriched = await fetchVideos(env, ids, 300);
	// Preserve the relevance order search returned; videos.list reorders by id.
	const byId = new Map(enriched.map((v) => [v.id, v]));
	return ids.map((id) => byId.get(id)).filter((v): v is SearchResult => !!v);
}

interface CommentThreadItem {
	snippet?: {
		topLevelComment?: {
			snippet?: {
				textDisplay?: string;
				authorDisplayName?: string;
				likeCount?: number;
				publishedAt?: string;
			};
		};
		totalReplyCount?: number;
	};
}

export async function youtubeThread(
	env: Env,
	opts: { id: string; sort: string; limit: number }
): Promise<Thread> {
	const [videos, commentsData] = await Promise.all([
		fetchVideos(env, [opts.id], 2000),
		// Comments can be disabled on a video; that shouldn't fail the whole call.
		ytGet(
			env,
			'commentThreads',
			new URLSearchParams({
				part: 'snippet',
				videoId: opts.id,
				order: opts.sort === 'new' ? 'time' : 'relevance',
				maxResults: String(Math.min(opts.limit, 100)),
				textFormat: 'plainText' // default is HTML
			})
		).catch(() => null)
	]);

	const video = videos[0];
	if (!video) throw new ProviderError(`YouTube video '${opts.id}' not found or is private.`);

	const items = (commentsData as { items?: CommentThreadItem[] } | null)?.items ?? [];
	const replies: ThreadComment[] = items.map((item) => {
		const c = item.snippet?.topLevelComment?.snippet;
		return {
			score: c?.likeCount ?? 0,
			author: c?.authorDisplayName ?? '',
			date: (c?.publishedAt ?? '').slice(0, 10),
			depth: 0, // only top-level comments are fetched
			text: trim(c?.textDisplay ?? '', 600)
		};
	});

	return {
		...video,
		replies,
		...(commentsData === null
			? { note: 'Comments are unavailable for this video (likely disabled by the uploader).' }
			: {})
	};
}
