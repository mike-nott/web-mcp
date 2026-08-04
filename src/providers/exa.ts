// Exa provider — neural/semantic search over the open web.
//
// Every other search source in this server is lexical (Reddit, X and YouTube
// all match terms literally), which is why their descriptions teach
// keyword-style querying. Exa matches meaning instead, so descriptive queries
// that name no keywords work. It also does find-similar, which nothing else
// here can do.
//
// `type` is pinned to "auto". Exa's deep/deep-reasoning research modes can run
// for minutes, and this server has no SSE keepalive (a deliberate phase-1
// choice), so a long call would hit the MCP client's tool timeout.

import type { Env } from '../env';
import { consumeBudget } from '../budget';
import { ProviderError } from './errors';
import type { WebResult } from './types';

const API_BASE = 'https://api.exa.ai';
const TEXT_MAX_CHARS = 3000; // per result — full pages would swamp the caller's context

export interface ExaArgs {
	query?: string;
	similarTo?: string;
	time: string;
	limit: number;
	content: 'highlights' | 'text' | 'none';
	includeDomains?: string[];
	excludeDomains?: string[];
	category?: string;
}

export interface ExaResponse {
	results: WebResult[];
	costUsd: number;
}

interface RawResult {
	title?: string;
	url?: string;
	publishedDate?: string;
	author?: string | null;
	text?: string;
	highlights?: string[];
}

interface RawResponse {
	results?: RawResult[];
	costDollars?: { total?: number };
	error?: string;
	message?: string;
}

function startPublishedDate(time: string): string | null {
	const days: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
	const n = days[time];
	return n ? new Date(Date.now() - n * 86400000).toISOString() : null;
}

function buildContents(args: ExaArgs): Record<string, unknown> | undefined {
	if (args.content === 'none') return undefined;
	if (args.content === 'text') {
		return { text: { maxCharacters: TEXT_MAX_CHARS, verbosity: 'compact' } };
	}
	// Highlights are query-relevant excerpts — far cheaper in context than full
	// pages. Passing the query makes them relevant to what was actually asked.
	return {
		highlights: {
			numSentences: 3,
			highlightsPerUrl: 3,
			...(args.query ? { query: args.query } : {})
		}
	};
}

export async function exaSearch(env: Env, args: ExaArgs): Promise<ExaResponse> {
	if (!env.EXA_API_KEY) {
		throw new ProviderError('EXA_API_KEY is not configured, so web_search is unavailable.');
	}
	await consumeBudget(env, 'exa');

	const findSimilar = !!args.similarTo;
	const body: Record<string, unknown> = {
		numResults: args.limit,
		...(findSimilar
			? { url: args.similarTo, excludeSourceDomain: true }
			: { query: args.query, type: 'auto' })
	};

	const since = startPublishedDate(args.time);
	if (since) body.startPublishedDate = since;
	if (args.includeDomains?.length) body.includeDomains = args.includeDomains;
	if (args.excludeDomains?.length) body.excludeDomains = args.excludeDomains;
	if (args.category) body.category = args.category;
	const contents = buildContents(args);
	if (contents) body.contents = contents;

	const res = await fetch(`${API_BASE}/${findSimilar ? 'findSimilar' : 'search'}`, {
		method: 'POST',
		headers: { 'x-api-key': env.EXA_API_KEY, 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});

	if (!res.ok) {
		const text = await res.text();
		if (res.status === 401 || res.status === 403) {
			throw new ProviderError('Exa rejected the API key — check EXA_API_KEY.');
		}
		if (res.status === 429) throw new ProviderError('Exa rate limit hit — retry shortly.');
		if (res.status === 402) {
			throw new ProviderError('Exa credits exhausted — top up at dashboard.exa.ai.');
		}
		throw new ProviderError(`Exa API error (${res.status}): ${text.slice(0, 200)}`);
	}

	const data = (await res.json()) as RawResponse;
	const results: WebResult[] = (data.results ?? []).map((r) => ({
		title: r.title ?? '',
		url: r.url ?? '',
		...(r.publishedDate ? { published: r.publishedDate.slice(0, 10) } : {}),
		...(r.author ? { author: r.author } : {}),
		...(r.highlights?.length ? { highlights: r.highlights } : {}),
		...(r.text ? { text: r.text } : {})
	}));

	return { results, costUsd: data.costDollars?.total ?? 0 };
}
