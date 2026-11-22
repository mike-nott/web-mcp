import type { Env } from './env';
import { BudgetExceededError } from './providers/errors';

const KEY_TTL_SECONDS = 172800; // 48h — key outlives its UTC day, then self-cleans

type PaidProvider =
	| 'discord'
	| 'x'
	| 'firecrawl'
	| 'youtube_search'
	| 'supadata'
	| 'exa'
	| 'brave'
	| 'tavily'
	| 'currents'
	| 'particle';

const SETTINGS: Record<
	PaidProvider,
	{ label: string; fallbackLimit: number; envVar: keyof Env; advice: string }
> = {
	discord: {
		label: 'Discord API call',
		// Low ceiling: user-token traffic is the volume-sensitive path — searches
		// are cached 1h, so normal use is a handful of calls a day; runaway backstop.
		fallbackLimit: 100,
		envVar: 'DISCORD_DAILY_CALL_LIMIT',
		advice:
			'Web search is unaffected — a site:discord.com query surfaces public snippets. ' +
			'Raise DISCORD_DAILY_CALL_LIMIT in wrangler.toml (or set it to 0 to disable the cap).'
	},
	x: {
		label: 'X API call',
		fallbackLimit: 500,
		envVar: 'X_DAILY_CALL_LIMIT',
		advice:
			'Reddit search is unaffected — retry with platform: "reddit", or raise X_DAILY_CALL_LIMIT in wrangler.toml.'
	},
	firecrawl: {
		label: 'FireCrawl scrape',
		fallbackLimit: 200,
		envVar: 'FIRECRAWL_DAILY_CALL_LIMIT',
		advice:
			'Pages that are not blocked still work (they never reach FireCrawl). Raise FIRECRAWL_DAILY_CALL_LIMIT in wrangler.toml to lift this.'
	},
	youtube_search: {
		label: 'YouTube search',
		fallbackLimit: 90,
		envVar: 'YOUTUBE_SEARCH_DAILY_LIMIT',
		// Only search is quota-scarce; metadata, comments and transcripts are unaffected.
		advice:
			'Find videos another way — use your own web search with site:youtube.com — then pass the video ids ' +
			'to get_thread or fetch_page, which still work normally. Google also grants quota increases on request.'
	},
	tavily: {
		label: 'Tavily keyword search',
		fallbackLimit: 500,
		envVar: 'TAVILY_DAILY_LIMIT',
		advice:
			'Semantic search (mode: "semantic") and the other tools are unaffected. Raise TAVILY_DAILY_LIMIT in wrangler.toml (or set it to 0 to disable the cap).'
	},
	brave: {
		label: 'Brave keyword search',
		fallbackLimit: 500,
		envVar: 'BRAVE_DAILY_CALL_LIMIT',
		advice:
			'Semantic search (mode: "semantic") and the other tools are unaffected. Raise BRAVE_DAILY_CALL_LIMIT in wrangler.toml (or set it to 0 to disable the cap).'
	},
	exa: {
		label: 'Exa web search',
		fallbackLimit: 200,
		envVar: 'EXA_DAILY_CALL_LIMIT',
		advice:
			'The other search tools are unaffected. Raise EXA_DAILY_CALL_LIMIT in wrangler.toml (or set it to 0 to disable the cap).'
	},
	supadata: {
		label: 'video transcript',
		fallbackLimit: 300,
		envVar: 'SUPADATA_DAILY_LIMIT',
		advice:
			'Video metadata and comments still work via get_thread. Raise SUPADATA_DAILY_LIMIT in wrangler.toml (or set it to 0 to disable the cap).'
	},
	currents: {
		label: 'news search',
		// Builder plan: 2,500/day, refused (not billed) past that.
		fallbackLimit: 2400,
		envVar: 'CURRENTS_DAILY_LIMIT',
		advice:
			'Keyword mode (mode: "keyword") still finds news. Raise CURRENTS_DAILY_LIMIT in wrangler.toml (or set it to 0 to disable the cap).'
	},
	particle: {
		label: 'podcast API call',
		// Individual plan: 10,000 calls/month with overage billed, so 300/day keeps a
		// month inside the plan. Counts searches and transcripts alike.
		fallbackLimit: 300,
		envVar: 'PARTICLE_DAILY_LIMIT',
		advice:
			'The other social platforms are unaffected. Raise PARTICLE_DAILY_LIMIT in wrangler.toml (or set it to 0 to disable the cap), bearing in mind overage is billed.'
	}
};

/** Returns the daily cap, or null when explicitly set to 0 (uncapped). */
function configuredLimit(env: Env, provider: PaidProvider): number | null {
	const { envVar, fallbackLimit } = SETTINGS[provider];
	const raw = String(env[envVar] ?? '').trim();
	if (raw === '0') return null;
	return Number.parseInt(raw, 10) || fallbackLimit;
}

/**
 * Counts paid-provider calls per UTC day in KV and refuses once the ceiling is
 * hit. KV increments aren't atomic, but this is a single-user worker —
 * approximate counting is fine; the ceiling is a cost guard, not an invariant.
 */
export async function consumeBudget(env: Env, provider: PaidProvider): Promise<void> {
	const limit = configuredLimit(env, provider);
	if (limit === null) return; // cap disabled
	const key = `budget:${provider}:${new Date().toISOString().slice(0, 10)}`;
	const current = Number.parseInt((await env.KV.get(key)) ?? '0', 10);
	if (current >= limit) {
		const { label, advice } = SETTINGS[provider];
		throw new BudgetExceededError(
			`Daily ${label} budget (${limit}) is exhausted. It resets at midnight UTC. ${advice}`
		);
	}
	await env.KV.put(key, String(current + 1), { expirationTtl: KEY_TTL_SECONDS });
}
