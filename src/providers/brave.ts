// Brave provider — keyword web search over Brave's own independent index.
//
// This is the plain-search half of web_search. It exists because semantic
// search is measurably weak at factual lookups (Exa 8.7 vs Brave 14.89 on
// agentic benchmarks), and because clients without their own web search — local
// LLMs in particular — otherwise have no way to answer "when was X released".
//
// Brave returns ranked SERP results with snippets, never full page text; use
// semantic mode or fetch_page when the page body is needed.

import type { Env } from '../env';
import { consumeBudget } from '../budget';
import { ProviderError } from './errors';
import type { KeywordArgs, KeywordResponse, WebResult } from './types';

const API_BASE = 'https://api.search.brave.com/res/v1/web/search';
const MAX_COUNT = 20; // Brave's hard cap, below our tool's limit of 25

// Brave enforces a per-second query limit (1 QPS on lower plans), so two
// searches in quick succession — routine during a research sweep — will 429
// without this. Verified live: back-to-back calls failed until retried.
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_BACKOFF_MS = 1200;

interface RawResult {
	title?: string;
	url?: string;
	description?: string;
	age?: string;
	page_age?: string;
	extra_snippets?: string[];
}

const FRESHNESS: Record<string, string> = {
	day: 'pd',
	week: 'pw',
	month: 'pm',
	year: 'py'
};

/**
 * Brave has no include/exclude domain parameters, but honours search operators
 * in the query itself, so the tool's domain filters are translated rather than
 * silently dropped.
 */
function applyDomainFilters(query: string, args: KeywordArgs): string {
	let q = query;
	if (args.includeDomains?.length) {
		const clause = args.includeDomains.map((d) => `site:${d}`).join(' OR ');
		q += args.includeDomains.length > 1 ? ` (${clause})` : ` ${clause}`;
	}
	if (args.excludeDomains?.length) {
		q += ' ' + args.excludeDomains.map((d) => `-site:${d}`).join(' ');
	}
	return q;
}

export async function braveSearch(env: Env, args: KeywordArgs): Promise<KeywordResponse> {
	if (!env.BRAVE_API_KEY) {
		throw new ProviderError(
			'BRAVE_API_KEY is not configured, so keyword search is unavailable on this server.'
		);
	}
	await consumeBudget(env, 'brave');

	const notes: string[] = [];
	const count = Math.min(args.limit, MAX_COUNT);
	if (args.limit > MAX_COUNT) {
		notes.push(`Brave returns at most ${MAX_COUNT} results per query, so limit was reduced from ${args.limit}.`);
	}
	if (args.content === 'text') {
		notes.push(
			'Keyword search returns snippets, not full page text. Use mode "semantic" for page ' +
				'extracts, or fetch_page to read a specific result in full.'
		);
	}

	const params = new URLSearchParams({
		q: applyDomainFilters(args.query, args),
		count: String(count)
	});
	if (args.content !== 'none') params.set('extra_snippets', 'true');
	const freshness = FRESHNESS[args.time];
	if (freshness) params.set('freshness', freshness);

	let res: Response | null = null;
	for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt++) {
		res = await fetch(`${API_BASE}?${params}`, {
			headers: {
				'X-Subscription-Token': env.BRAVE_API_KEY,
				Accept: 'application/json'
			}
		});
		if (res.status !== 429 || attempt === RATE_LIMIT_RETRIES) break;
		await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_BACKOFF_MS));
	}

	if (!res || !res.ok) {
		const body = res ? await res.text() : '';
		const status = res?.status ?? 0;
		if (status === 401 || status === 403) {
			throw new ProviderError('Brave rejected the API key — check BRAVE_API_KEY.');
		}
		if (status === 429) {
			throw new ProviderError(
				"Brave rate limit hit and still limited after retrying — your plan's queries-per-second " +
					'limit is saturated. Space searches out, or upgrade the plan.'
			);
		}
		if (status === 402) {
			throw new ProviderError(
				'Brave credits exhausted — top up at api-dashboard.search.brave.com.'
			);
		}
		throw new ProviderError(`Brave API error (${status}): ${body.slice(0, 200)}`);
	}

	const data = (await res.json()) as { web?: { results?: RawResult[] } };
	const results: WebResult[] = (data.web?.results ?? []).map((r) => {
		// The description is the primary snippet; extra_snippets add up to 5 more.
		const highlights = [r.description, ...(r.extra_snippets ?? [])].filter(
			(s): s is string => !!s && s.trim().length > 0
		);
		const published = r.page_age ?? r.age;
		return {
			title: r.title ?? '',
			url: r.url ?? '',
			...(published ? { published: published.slice(0, 10) } : {}),
			...(args.content !== 'none' && highlights.length ? { highlights } : {})
		};
	});

	return { results, notes, engine: 'brave' };
}
