// Currents provider — news article search (currentsapi.services).
//
// Returns headline, a description, the publisher's URL, author and date. There
// is no article body field, so the caller reads a full article with fetch_page
// on its URL (normally the free direct tier).
//
// Verified against the live API 2026-11-22: Bearer auth; `domain` and
// `domain_not` take comma-separated lists; `country` takes ISO codes ("GB");
// `language` defaults to "en" when omitted; a single search may span at most
// 31 days (400 INVALID_QUERY otherwise); without start_date results come
// newest first. The daily allowance resets at 00:00 UTC.
//
// The search text goes in `query`, not `keywords`: `keywords` matches ANY word
// ("electricity prices" returned a car-price story), while `query` requires
// every word and also takes OR, NOT and "quoted phrases" (20/20 results held
// both words against 18/20, measured 2026-11-22).
//
// Currents' terms prohibit keeping copies, so results are cached only briefly
// (NEWS_CACHE_TTL) rather than for the usual hour.

import type { Env } from '../env';
import { consumeBudget } from '../budget';
import { ProviderError } from './errors';
import type { WebResult } from './types';

const API_BASE = 'https://api.currentsapi.services/v1';
const MAX_SPAN_DAYS = 31;
const HIGHLIGHT_MAX = 500;

export interface NewsArgs {
	query: string;
	time: string;
	limit: number;
	content: 'highlights' | 'text' | 'none';
	includeDomains?: string[];
	excludeDomains?: string[];
	country?: string;
	language?: string;
}

export interface NewsResponse {
	results: WebResult[];
	notes: string[];
}

interface RawArticle {
	title?: string;
	description?: string;
	url?: string;
	author?: string | null;
	published?: string;
}

interface RawResponse {
	news?: RawArticle[];
	details?: { errors?: Record<string, string> };
}

const SPAN_DAYS: Record<string, number> = { day: 1, week: 7, month: 30 };

/** "2026-11-22 15:00:34 +0000" → "2026-11-22". */
function toDate(published: string | undefined): string | undefined {
	const m = published?.match(/^(\d{4}-\d{2}-\d{2})/);
	return m ? m[1] : undefined;
}

export async function currentsSearch(env: Env, args: NewsArgs): Promise<NewsResponse> {
	if (!env.CURRENTS_API_KEY) {
		throw new ProviderError('CURRENTS_API_KEY is not configured, so news search is unavailable.');
	}
	await consumeBudget(env, 'currents');

	const notes: string[] = [];
	const params = new URLSearchParams({
		query: args.query,
		page_size: String(args.limit),
		language: args.language ?? 'en'
	});
	const days = SPAN_DAYS[args.time];
	if (days) {
		params.set('start_date', new Date(Date.now() - days * 86400000).toISOString());
	} else if (args.time === 'year') {
		// "all" needs no note: no date filter is what it asks for.
		notes.push(
			`News search cannot filter a range longer than ${MAX_SPAN_DAYS} days, so time "year" ` +
				'returns the newest matching articles without a date filter.'
		);
	}
	if (args.country) params.set('country', args.country);
	if (args.includeDomains?.length) params.set('domain', args.includeDomains.join(','));
	if (args.excludeDomains?.length) params.set('domain_not', args.excludeDomains.join(','));

	const res = await fetch(`${API_BASE}/search?${params}`, {
		headers: { Authorization: `Bearer ${env.CURRENTS_API_KEY}` }
	});

	if (!res.ok) {
		const text = await res.text();
		if (res.status === 401 || res.status === 403) {
			throw new ProviderError('Currents rejected the API key — check CURRENTS_API_KEY.');
		}
		if (res.status === 429) {
			const retry = res.headers.get('retry-after');
			throw new ProviderError(
				'Currents rate limit or daily allowance reached' +
					(retry ? ` — retry after ${retry} seconds.` : ' — it resets at midnight UTC.')
			);
		}
		if (res.status === 400) {
			let detail = text.slice(0, 200);
			try {
				const errors = (JSON.parse(text) as RawResponse).details?.errors;
				if (errors) detail = Object.entries(errors).map(([k, v]) => `${k}: ${v}`).join('; ');
			} catch {
				// Keep the raw text.
			}
			throw new ProviderError(`Currents rejected the search: ${detail}`);
		}
		throw new ProviderError(`Currents API error (${res.status}): ${text.slice(0, 200)}`);
	}

	// On the Builder plan the description often runs to 2,500–3,600 characters
	// (measured 2026-11-22), close to the article itself. "highlights" keeps the
	// opening; "text" returns all of it; "none" drops it.
	const data = (await res.json()) as RawResponse;
	const results: WebResult[] = (data.news ?? []).map((a) => {
		const published = toDate(a.published);
		const author = a.author?.trim();
		const description = a.description?.trim() ?? '';
		const body =
			!description || args.content === 'none'
				? {}
				: args.content === 'text'
					? { text: description }
					: {
							highlights: [
								description.length > HIGHLIGHT_MAX
									? description.slice(0, HIGHLIGHT_MAX) + '…'
									: description
							]
						};
		return {
			title: a.title ?? '',
			url: a.url ?? '',
			...(published ? { published } : {}),
			...(author ? { author } : {}),
			...body
		};
	});
	return { results, notes };
}
