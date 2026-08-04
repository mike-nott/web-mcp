// Thin KV response cache. Key = kind + SHA-256 of the canonicalised params, so
// identical queries from any session share one upstream call within the TTL.

export const SEARCH_CACHE_TTL = 3600; // 1h
export const THREAD_CACHE_TTL = 900; // 15min

export async function cacheKey(kind: string, params: Record<string, unknown>): Promise<string> {
	const canonical = JSON.stringify(
		Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)))
	);
	const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
	const hex = Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	return `cache:${kind}:${hex}`;
}

export async function getCached(kv: KVNamespace, key: string): Promise<string | null> {
	return kv.get(key);
}

export async function putCached(
	kv: KVNamespace,
	key: string,
	value: string,
	ttlSeconds: number
): Promise<void> {
	await kv.put(key, value, { expirationTtl: ttlSeconds });
}
