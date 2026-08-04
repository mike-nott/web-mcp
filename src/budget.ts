import type { Env } from './env';
import { BudgetExceededError } from './providers/errors';

const KEY_TTL_SECONDS = 172800; // 48h — key outlives its UTC day, then self-cleans

type PaidProvider = 'x' | 'firecrawl' | 'youtube_search' | 'supadata';

const SETTINGS: Record<
	PaidProvider,
	{ label: string; fallbackLimit: number; envVar: keyof Env; advice: string }
> = {
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
	supadata: {
		label: 'video transcript',
		fallbackLimit: 300,
		envVar: 'SUPADATA_DAILY_LIMIT',
		advice:
			'Video metadata and comments still work via get_thread. Raise SUPADATA_DAILY_LIMIT in wrangler.toml (or set it to 0 to disable the cap).'
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
