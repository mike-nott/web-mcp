import type { Env } from './env';
import { BudgetExceededError } from './providers/errors';

const KEY_TTL_SECONDS = 172800; // 48h — key outlives its UTC day, then self-cleans

/**
 * Counts X API calls per UTC day in KV and refuses once the ceiling is hit.
 * KV increments aren't atomic, but this is a single-user worker — approximate
 * counting is fine; the ceiling is a cost guard, not an invariant.
 */
export async function consumeXBudget(env: Env): Promise<void> {
	const limit = Number.parseInt(env.X_DAILY_CALL_LIMIT, 10) || 500;
	const key = `budget:x:${new Date().toISOString().slice(0, 10)}`;
	const current = Number.parseInt((await env.KV.get(key)) ?? '0', 10);
	if (current >= limit) {
		throw new BudgetExceededError(
			`Daily X API call budget (${limit}) is exhausted. It resets at midnight UTC. ` +
				'Reddit search is unaffected — retry with platform: "reddit", or raise X_DAILY_CALL_LIMIT in wrangler.toml.'
		);
	}
	await env.KV.put(key, String(current + 1), { expirationTtl: KEY_TTL_SECONDS });
}
