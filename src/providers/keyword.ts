// Keyword search dispatch. Two engines back `web_search` mode "keyword"; the
// caller never sees which, keeping the tool surface engine-neutral.
//
// KEYWORD_SEARCH_PROVIDER selects: "auto" (default) prefers Tavily because it
// has the only free tier, falling back to Brave; "tavily" or "brave" force one.

import type { Env } from '../env';
import { ProviderError } from './errors';
import type { KeywordArgs, KeywordResponse } from './types';
import { braveSearch } from './brave';
import { tavilySearch } from './tavily';

export type KeywordEngine = 'brave' | 'tavily';

const ENV_VAR: Record<KeywordEngine, string> = {
	brave: 'BRAVE_API_KEY',
	tavily: 'TAVILY_API_KEY'
};

/** Which engine a given config resolves to, or null when none is available. */
export function resolveKeywordEngine(env: Env): KeywordEngine | null {
	const hasBrave = !!env.BRAVE_API_KEY?.trim();
	const hasTavily = !!env.TAVILY_API_KEY?.trim();
	const preference = (env.KEYWORD_SEARCH_PROVIDER ?? 'auto').trim().toLowerCase();

	if (preference === 'brave') return hasBrave ? 'brave' : null;
	if (preference === 'tavily') return hasTavily ? 'tavily' : null;
	// auto — free tier first
	if (hasTavily) return 'tavily';
	if (hasBrave) return 'brave';
	return null;
}

export async function keywordSearch(env: Env, args: KeywordArgs): Promise<KeywordResponse> {
	const engine = resolveKeywordEngine(env);
	if (!engine) {
		const preference = (env.KEYWORD_SEARCH_PROVIDER ?? 'auto').trim().toLowerCase();
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
	return engine === 'tavily' ? tavilySearch(env, args) : braveSearch(env, args);
}
