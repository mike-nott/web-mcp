import type { Env } from './env';
import { BudgetExceededError } from './providers/errors';

const KEY_TTL_SECONDS = 172800; // 48h — key outlives its UTC day, then self-cleans

type PaidProvider = 'x' | 'firecrawl';

const SETTINGS: Record<PaidProvider, { label: string; fallbackLimit: number; advice: string }> = {
	x: {
		label: 'X API call',
		fallbackLimit: 500,
		advice:
			'Reddit search is unaffected — retry with platform: "reddit", or raise X_DAILY_CALL_LIMIT in wrangler.toml.'
	},
	firecrawl: {
		label: 'FireCrawl scrape',
		fallbackLimit: 200,
		advice:
			'Pages that are not blocked still work (they never reach FireCrawl). Raise FIRECRAWL_DAILY_CALL_LIMIT in wrangler.toml to lift this.'
	}
};

function configuredLimit(env: Env, provider: PaidProvider): number {
	const raw = provider === 'x' ? env.X_DAILY_CALL_LIMIT : env.FIRECRAWL_DAILY_CALL_LIMIT;
	return Number.parseInt(raw, 10) || SETTINGS[provider].fallbackLimit;
}

/**
 * Counts paid-provider calls per UTC day in KV and refuses once the ceiling is
 * hit. KV increments aren't atomic, but this is a single-user worker —
 * approximate counting is fine; the ceiling is a cost guard, not an invariant.
 */
export async function consumeBudget(env: Env, provider: PaidProvider): Promise<void> {
	const limit = configuredLimit(env, provider);
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
