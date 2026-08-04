// Keyword search dispatch. Two engines back `web_search` mode "keyword"; the
// caller never picks one, keeping the tool surface engine-neutral.
//
// KEYWORD_SEARCH_PROVIDER selects:
//   auto (default) — Tavily if configured (it has the only free tier), else Brave
//   tavily | brave — force one
//   both           — query both in parallel and merge
//
// "both" is additive in two ways, which is why it exists: the indexes are
// independent (better recall), and the engines return different FIELDS — Brave
// gives publication dates and never page text, Tavily gives page text and never
// dates. Merging on a shared URL yields a result neither engine can produce
// alone.

import type { Env } from '../env';
import { ProviderError } from './errors';
import type { KeywordArgs, KeywordResponse, WebResult } from './types';
import { braveSearch } from './brave';
import { tavilySearch } from './tavily';

export type KeywordEngine = 'brave' | 'tavily';

const ENV_VAR: Record<KeywordEngine, string> = {
	brave: 'BRAVE_API_KEY',
	tavily: 'TAVILY_API_KEY'
};

function preferenceOf(env: Env): string {
	return (env.KEYWORD_SEARCH_PROVIDER ?? 'auto').trim().toLowerCase();
}

/** Engines this config resolves to, in preference order. Empty when none are usable. */
export function resolveKeywordEngines(env: Env): KeywordEngine[] {
	const hasBrave = !!env.BRAVE_API_KEY?.trim();
	const hasTavily = !!env.TAVILY_API_KEY?.trim();
	const preference = preferenceOf(env);

	if (preference === 'brave') return hasBrave ? ['brave'] : [];
	if (preference === 'tavily') return hasTavily ? ['tavily'] : [];
	if (preference === 'both') {
		const both: KeywordEngine[] = [];
		if (hasTavily) both.push('tavily');
		if (hasBrave) both.push('brave');
		return both;
	}
	// auto — free tier first
	if (hasTavily) return ['tavily'];
	if (hasBrave) return ['brave'];
	return [];
}

/**
 * Match key for de-duplication only — the original URL is preserved in output.
 * Drops scheme, a leading www., any trailing slash and the fragment, so that
 * https://www.example.com/a/ and http://example.com/a#top collapse together.
 */
function dedupeKey(rawUrl: string): string {
	try {
		const u = new URL(rawUrl);
		const host = u.hostname.toLowerCase().replace(/^www\./, '');
		const path = u.pathname.replace(/\/+$/, '');
		return `${host}${path}${u.search}`;
	} catch {
		return rawUrl.trim().toLowerCase();
	}
}

/** First non-empty value wins per field, so each engine's exclusive fields survive. */
function mergeResults(base: WebResult, extra: WebResult, engine: KeywordEngine): WebResult {
	const highlights = [...(base.highlights ?? []), ...(extra.highlights ?? [])];
	return {
		...base,
		title: base.title || extra.title,
		published: base.published ?? extra.published,
		author: base.author ?? extra.author,
		text: base.text ?? extra.text,
		...(highlights.length ? { highlights: [...new Set(highlights)] } : {}),
		engines: [...new Set([...(base.engines ?? []), engine])]
	};
}

/**
 * Round-robin across engines, preserving each one's own ranking: rank 1 from
 * each, then rank 2, skipping URLs already emitted. No re-scoring happens here
 * — ordering is a merge of two orderings, not a judgement about them.
 */
function interleave(
	perEngine: Array<{ engine: KeywordEngine; results: WebResult[] }>,
	limit: number
): WebResult[] {
	const byKey = new Map<string, WebResult>();
	const order: string[] = [];
	const depth = Math.max(0, ...perEngine.map((e) => e.results.length));

	for (let rank = 0; rank < depth; rank++) {
		for (const { engine, results } of perEngine) {
			const result = results[rank];
			if (!result) continue;
			const key = dedupeKey(result.url);
			const existing = byKey.get(key);
			if (existing) {
				byKey.set(key, mergeResults(existing, result, engine));
			} else {
				byKey.set(key, { ...result, engines: [engine] });
				order.push(key);
			}
		}
	}

	// A result found later by the second engine still merges into its first
	// position, so the ordering reflects the best rank either engine gave it.
	return order.slice(0, limit).map((key) => byKey.get(key) as WebResult);
}

async function runEngine(
	env: Env,
	engine: KeywordEngine,
	args: KeywordArgs
): Promise<KeywordResponse> {
	return engine === 'tavily' ? tavilySearch(env, args) : braveSearch(env, args);
}

export async function keywordSearch(env: Env, args: KeywordArgs): Promise<KeywordResponse> {
	const engines = resolveKeywordEngines(env);
	if (engines.length === 0) {
		const preference = preferenceOf(env);
		if (preference === 'brave' || preference === 'tavily') {
			throw new ProviderError(
				`KEYWORD_SEARCH_PROVIDER is set to "${preference}" but ${ENV_VAR[preference as KeywordEngine]} ` +
					'is not configured. Set that key, or switch KEYWORD_SEARCH_PROVIDER.'
			);
		}
		throw new ProviderError(
			'No keyword search engine is configured — set TAVILY_API_KEY or BRAVE_API_KEY.'
		);
	}

	if (engines.length === 1) return runEngine(env, engines[0], args);

	const settled = await Promise.allSettled(engines.map((e) => runEngine(env, e, args)));
	const succeeded: Array<{ engine: KeywordEngine; results: WebResult[] }> = [];
	const notes: string[] = [];

	settled.forEach((outcome, i) => {
		const engine = engines[i];
		if (outcome.status === 'fulfilled') {
			succeeded.push({ engine, results: outcome.value.results });
			notes.push(...outcome.value.notes);
		} else {
			const message =
				outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
			notes.push(`${engine} returned no results (${message})`);
		}
	});

	if (succeeded.length === 0) {
		throw new ProviderError(`All keyword engines failed. ${notes.join(' | ')}`);
	}

	return {
		results: interleave(succeeded, args.limit),
		notes: [...new Set(notes)],
		engines: succeeded.map((s) => s.engine)
	};
}
