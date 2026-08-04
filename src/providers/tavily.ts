// Tavily provider — the alternative keyword engine, and the default when
// configured because it is the only one with a free tier (1,000 credits/month),
// which matters for a public "deploy your own" repo where Brave now requires
// payment before keyword search works at all.
//
// Advantages over Brave: native include/exclude domain params (no site: string
// building) and real page text via include_raw_content. Trade-offs: no
// published date on results, and although their docs describe a `usage.credits`
// field the live API does not return one (verified 2026-08-04) — it is read
// defensively here in case that changes, but expect it to be absent.

import type { Env } from '../env';
import { consumeBudget } from '../budget';
import { ProviderError } from './errors';
import type { KeywordArgs, KeywordResponse, WebResult } from './types';

const API_URL = 'https://api.tavily.com/search';
const MAX_RESULTS = 20;

interface RawResult {
	title?: string;
	url?: string;
	content?: string;
	raw_content?: string | null;
	score?: number;
}

interface RawResponse {
	results?: RawResult[];
	usage?: { credits?: number };
}

const TIME_RANGE: Record<string, string> = {
	day: 'day',
	week: 'week',
	month: 'month',
	year: 'year'
};

export async function tavilySearch(env: Env, args: KeywordArgs): Promise<KeywordResponse> {
	if (!env.TAVILY_API_KEY) {
		throw new ProviderError('TAVILY_API_KEY is not configured.');
	}
	await consumeBudget(env, 'tavily');

	const notes: string[] = [];
	const maxResults = Math.min(args.limit, MAX_RESULTS);
	if (args.limit > MAX_RESULTS) {
		notes.push(
			`Tavily returns at most ${MAX_RESULTS} results per query, so limit was reduced from ${args.limit}.`
		);
	}

	const body: Record<string, unknown> = {
		query: args.query,
		// "basic" is 1 credit; "advanced" doubles the cost for a marginal gain,
		// and predictable spend matters more here.
		search_depth: 'basic',
		max_results: maxResults,
		chunks_per_source: 3,
		// include_answer is deliberately NOT used: it returns an LLM-written
		// answer, and this server does no reasoning of its own — the calling
		// model does that.
		include_answer: false,
		...(args.content === 'text' ? { include_raw_content: 'markdown' } : {})
	};
	const range = TIME_RANGE[args.time];
	if (range) body.time_range = range;
	if (args.includeDomains?.length) body.include_domains = args.includeDomains;
	if (args.excludeDomains?.length) body.exclude_domains = args.excludeDomains;

	const res = await fetch(API_URL, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.TAVILY_API_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(body)
	});

	if (!res.ok) {
		const text = await res.text();
		if (res.status === 401 || res.status === 403) {
			throw new ProviderError('Tavily rejected the API key — check TAVILY_API_KEY.');
		}
		if (res.status === 429) throw new ProviderError('Tavily rate limit hit — retry shortly.');
		if (res.status === 432 || res.status === 402) {
			throw new ProviderError(
				'Tavily plan limit reached — the monthly credit allowance is exhausted. Top up at app.tavily.com.'
			);
		}
		throw new ProviderError(`Tavily API error (${res.status}): ${text.slice(0, 200)}`);
	}

	const data = (await res.json()) as RawResponse;
	const results: WebResult[] = (data.results ?? []).map((r) => {
		const snippet = (r.content ?? '').trim();
		const full = (r.raw_content ?? '').trim();
		return {
			title: r.title ?? '',
			url: r.url ?? '',
			// Tavily returns no publication date, so `published` is simply absent.
			...(args.content === 'text' && full ? { text: full } : {}),
			...(args.content === 'highlights' && snippet ? { highlights: [snippet] } : {})
		};
	});

	return { results, notes, engine: 'tavily', creditsUsed: data.usage?.credits };
}
