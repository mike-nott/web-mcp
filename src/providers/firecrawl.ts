// FireCrawl provider (tier 2) — ported from
// ayima-chat/src/lib/server/tools/firecrawl/client.ts, which is already raw
// fetch() with no npm packages. Two deliberate improvements over that version:
//
//  1. proxy: 'auto' — ayima-chat never sets a proxy mode, so its scrapes still
//     lose to stronger WAFs. 'auto' tries basic first and retries with the
//     enhanced proxy only when needed (5 credits only in that case).
//  2. Strict success validation — ayima-chat checks `success` alone, so a 403
//     challenge page comes back as success:true with junk markdown and reaches
//     the model as if it were content. That is the exact failure this tool
//     exists to prevent, so statusCode and content length are checked too.

import type { Env } from '../env';
import { consumeBudget } from '../budget';
import { ProviderError } from './errors';

const API_BASE = 'https://api.firecrawl.dev/v2';
const SCRAPE_TIMEOUT_MS = 30000; // stays inside MCP client tool timeouts (no SSE keepalive)
const CACHE_MAX_AGE_MS = 172800000; // 48h — reuse FireCrawl's own page cache
const THIN_CONTENT = 200;

// Short content alone doesn't mean blocked — plenty of legitimate pages and
// small PDFs are brief. Only treat it as a wall when the text also reads like
// a challenge or login prompt.
const WALL_MARKERS = [
	'just a moment',
	'checking your browser',
	'verify you are human',
	'are you a robot',
	'enable javascript',
	'access denied',
	'attention required',
	'sign in to continue',
	'log in to continue',
	'subscribe to continue',
	'captcha'
];

export interface ScrapedPage {
	finalUrl: string;
	title: string;
	status: number;
	content: string;
	note?: string;
}

interface FirecrawlResponse {
	success?: boolean;
	error?: string;
	data?: {
		markdown?: string;
		metadata?: {
			title?: string | string[];
			statusCode?: number;
			sourceURL?: string;
			url?: string;
		};
	};
}

function first(value: string | string[] | undefined): string {
	if (Array.isArray(value)) return value[0] ?? '';
	return value ?? '';
}

async function post(env: Env, body: unknown, retriedOn429 = false): Promise<FirecrawlResponse> {
	const res = await fetch(`${API_BASE}/scrape`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.FIRECRAWL_API_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(body)
	});

	if (!res.ok) {
		if (res.status === 429 && !retriedOn429) {
			// ayima-chat has no retry here at all; one backoff is cheap insurance.
			await new Promise((resolve) => setTimeout(resolve, 2000));
			return post(env, body, true);
		}
		const text = await res.text();
		if (res.status === 402) {
			throw new ProviderError(
				'FireCrawl credits exhausted — top up at firecrawl.dev to keep fetching walled pages.'
			);
		}
		if (res.status === 429) throw new ProviderError('FireCrawl rate limit exceeded — retry shortly.');
		if (res.status === 403) throw new ProviderError('FireCrawl access denied (check API key).');
		throw new ProviderError(`FireCrawl API error (${res.status}): ${text.slice(0, 200)}`);
	}

	return (await res.json()) as FirecrawlResponse;
}

export async function firecrawlScrape(env: Env, url: string): Promise<ScrapedPage> {
	if (!env.FIRECRAWL_API_KEY) {
		throw new ProviderError(
			'FIRECRAWL_API_KEY is not configured, so blocked pages cannot be retrieved.'
		);
	}
	await consumeBudget(env, 'firecrawl');

	const result = await post(env, {
		url,
		formats: ['markdown'],
		onlyMainContent: true,
		proxy: 'auto',
		blockAds: true,
		maxAge: CACHE_MAX_AGE_MS,
		timeout: SCRAPE_TIMEOUT_MS
	});

	if (!result.success) {
		throw new ProviderError(`FireCrawl could not scrape the page: ${result.error ?? 'unknown error'}`);
	}

	const metadata = result.data?.metadata ?? {};
	const status = metadata.statusCode ?? 0;
	const content = (result.data?.markdown ?? '').trim();

	if (status >= 400) {
		throw new ProviderError(
			`The page returned HTTP ${status} even through FireCrawl — it is unavailable or hard-blocked, not readable content.`
		);
	}
	if (!content) {
		throw new ProviderError(
			'FireCrawl returned an empty document — the page has no extractable content.'
		);
	}
	if (content.length < THIN_CONTENT) {
		const haystack = content.toLowerCase();
		if (WALL_MARKERS.some((marker) => haystack.includes(marker))) {
			throw new ProviderError(
				`The page is behind a challenge or login wall — FireCrawl retrieved only ${content.length} characters of interstitial text, not the article.`
			);
		}
	}

	return {
		finalUrl: metadata.url ?? metadata.sourceURL ?? url,
		title: first(metadata.title),
		status: status || 200,
		content,
		...(content.length < THIN_CONTENT
			? { note: `Page is unusually short (${content.length} chars) — verify it is the full content.` }
			: {})
	};
}
