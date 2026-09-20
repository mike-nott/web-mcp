// Discord provider — guild message search via the documented (2026) endpoint
// GET /guilds/{guild.id}/messages/search, called with a dedicated user account's
// token, relayed through the local companion (see proxy.ts and src/relay.ts for
// why the request cannot originate from the worker).
//
// Not contractual like the official APIs: the endpoint is documented but the
// user-token auth path is not, so responses are read defensively and 202 (index
// warming, code 110000) is retried rather than surfaced as an error.
//
// Scope decision: search only — no threads, no
// history crawling. Engagement signals do not exist here: Discord search returns
// message text without reactions, so score/comments are absent rather than
// invented (the SearchResult fields are optional for exactly this).

import type { Env } from '../env';
import { consumeBudget } from '../budget';
import { ProviderError } from './errors';
import { relayDiscordGet, discordHeaders, type RelayResult } from './proxy';
import type { SearchResult } from './types';

const API_BASE = 'https://discord.com/api/v10';
// The API enforces 25 per page; offset maxes at 9975 (documented).
const MAX_RESULTS = 25;
// Retry cadence for 202 Accepted (index warming). One backoff usually clears it;
// two retries stay inside client idle timeouts on the slow proxied path.
const WARMING_RETRIES = 2;
const WARMING_BACKOFF_MS = 3000;
// The account's guilds rarely change; 24h matches COMMUNITY_CACHE_TTL.
const GUILD_CACHE_TTL_SECONDS = 86400;

interface RawUser {
	id: string;
	username: string;
	global_name?: string | null;
}

interface RawAttachment {
	filename?: string;
	content_type?: string;
}

interface RawMessage {
	id: string;
	content: string;
	timestamp?: string;
	author?: { id?: string; username?: string; global_name?: string | null; bot?: boolean };
	attachments?: RawAttachment[];
	embeds?: unknown[];
	// Search responses wrap matches in a hit object with a metadata map.
	hit?: boolean;
	metadata?: { joined_at?: string; has?: string };
	channel_id?: string;
}

interface RawSearchResponse {
	total_results?: number;
	messages?: RawHitGroup[];
	documents_indexed?: number;
	doing_deep_historical_index?: boolean;
}

/** One hit group: the matched message plus, for replies, its parent context. */
type RawHitGroup = RawMessage[];

interface RawGuild {
	id: string;
	name: string;
}

export interface DiscordSearchArgs {
	query: string;
	/** Guild name (resolved via the account's guild list) or bare guild id. */
	guild?: string;
	/** Optional channel id filter, passed through to the endpoint. */
	channelId?: string;
	time: string;
	sort: 'relevance' | 'top' | 'new';
	limit: number;
}

export interface DiscordGuild {
	id: string;
	name: string;
}

const TIME_RANGE_DAYS: Record<string, number> = {
	day: 1,
	week: 7,
	month: 30,
	year: 365
};

/**
 * Time window as a snowflake message id for the documented min_id param.
 * Snowflakes encode timestamp as (ms - Discord epoch 1420070400000) << 22.
 * Returns null for 'all' (no window). Note: Discord's REST search ignores
 * `after:` tokens embedded in the content param — only the dedicated
 * min_id/max_id params filter by time (verified 2026-09).
 */
function timeFilterSnowflake(time: string): string | null {
	const days = TIME_RANGE_DAYS[time];
	if (!days) return null;
	const sinceMs = Date.now() - days * 86400_000;
	return (BigInt(Math.max(0, sinceMs - 1420070400000)) << 22n).toString();
}

function sortParams(sort: string): { sort_by: string; sort_order: string } {
	// 'top' has no Discord equivalent without reactions; fall back to timestamp
	// descending, which is what 'top' degrades to on a platform without scores.
	if (sort === 'new') return { sort_by: 'timestamp', sort_order: 'desc' };
	if (sort === 'top') return { sort_by: 'timestamp', sort_order: 'desc' };
	return { sort_by: 'relevance', sort_order: 'desc' };
}

async function discordGet(env: Env, path: string, retried = false): Promise<RelayResult> {
	let res: RelayResult;
	try {
		res = await relayDiscordGet(env, path, discordHeaders(env));
	} catch (err) {
		throw new ProviderError(err instanceof Error ? err.message : 'Discord relay failed.');
	}
	if (res.status === 202 && !retried) {
		// 202 + code 110000: search index still building for this guild. Back off
		// and retry once or twice before giving up.
		for (let i = 0; i < WARMING_RETRIES; i++) {
			const { promise: backoff, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, WARMING_BACKOFF_MS);
			await backoff;
			const retry = await discordGet(env, path, true);
			if (retry.status !== 202) return retry;
		}
		throw new ProviderError(
			'Discord is still indexing this server (HTTP 202). Try again in a few minutes.'
		);
	}
	if (res.status === 401) {
		throw new ProviderError(
			'Discord rejected the token (HTTP 401). DISCORD_USER_TOKEN may have been rotated ' +
				'(password change or logout-all) — re-set it with `wrangler secret put DISCORD_USER_TOKEN`.'
		);
	}
	if (res.status === 403) {
		throw new ProviderError(
			`Discord denied access (HTTP 403): ${res.body.slice(0, 300)}`
		);
	}
	if (res.status === 429) {
		throw new ProviderError(
			'Discord rate limit hit (HTTP 429). Results are cached for 1 hour, so repeat ' +
				'searches are free — wait before retrying with the same query.'
		);
	}
	if (res.status === 0) {
		// The companion's fetch threw before Discord answered — the body carries
		// the network error text (DNS, TLS, header validation, ...).
		throw new ProviderError(`Companion could not reach Discord: ${res.body.slice(0, 300)}`);
	}
	if (res.status < 200 || res.status >= 300) {
		throw new ProviderError(`Discord API error (HTTP ${res.status}) on ${path}`);
	}
	return res;
}

async function discordGetJson(env: Env, path: string): Promise<unknown> {
	const res = await discordGet(env, path);
	return JSON.parse(res.body) as unknown;
}

/** Guilds the account can see, KV-cached for 24h (the list moves slowly). */
export async function discordGuilds(env: Env): Promise<DiscordGuild[]> {
	const cached = await env.KV.get('discord:guilds');
	if (cached) {
		const parsed = JSON.parse(cached) as DiscordGuild[];
		if (Array.isArray(parsed) && parsed.length > 0) return parsed;
	}
	await consumeBudget(env, 'discord');
	const res = await discordGet(env, '/users/@me/guilds?with_counts=true');
	const raw = JSON.parse(res.body) as RawGuild[];
	const guilds = raw.map((g) => ({ id: g.id, name: g.name }));
	await env.KV.put('discord:guilds', JSON.stringify(guilds), {
		expirationTtl: GUILD_CACHE_TTL_SECONDS
	});
	return guilds;
}

/** Guild name → id. Names are matched case-insensitively; ids pass through. */
async function resolveGuild(env: Env, guild: string): Promise<string> {
	if (/^\d{5,}$/.test(guild)) return guild;
	const guilds = await discordGuilds(env);
	const match = guilds.find(
		(g) => g.name.toLowerCase() === guild.toLowerCase() || g.id === guild
	);
	if (!match) {
		const known = guilds.map((g) => g.name).slice(0, 15).join(', ');
		throw new ProviderError(
			`No Discord server named '${guild}' is visible to the configured account. ` +
				(known ? `Visible: ${known}.` : 'The account may not have joined any servers yet.')
		);
	}
	return match.id;
}

/**
 * Search responses arrive as `messages: RawMessage[][]` — one inner array per
 * hit, because a hit may be a reply chain (the hit itself plus its parent).
 * hit=true marks the actual match; without it the first entry is the match.
 */
function flattenHits(groups: RawHitGroup[]): RawMessage[] {
	return groups
		.map((group) => group.find((m) => m.hit === true) ?? group[0])
		.filter((m): m is RawMessage => Boolean(m));
}

function mapMessage(m: RawMessage, guildId: string): SearchResult {
	const author = m.author?.global_name || m.author?.username || '?';
	return {
		platform: 'discord',
		id: m.id,
		text: m.content,
		author,
		date: (m.timestamp ?? '').slice(0, 10),
		url: `https://discord.com/channels/${guildId}/${m.channel_id ?? ''}/${m.id}`
	};
}

export async function discordSearch(env: Env, args: DiscordSearchArgs): Promise<SearchResult[]> {
	if (!env.DISCORD_USER_TOKEN) {
		throw new ProviderError(
			'DISCORD_USER_TOKEN is not configured. See the README for how to obtain it.'
		);
	}
	if (!env.DISCORD_RELAY_SECRET) {
		throw new ProviderError(
			'DISCORD_RELAY_SECRET is not configured. The Discord search request is relayed ' +
				'through the local companion; the shared secret ' +
				'authenticates that WebSocket.'
		);
	}
	await consumeBudget(env, 'discord');

	// No guild specified: search every guild the account is in and merge.
	// One REST call per guild is the API's shape (search is per-guild only);
	// failures are per-guild (a guild still indexing its search returns 202
	// there), so allSettled keeps one cold guild from killing the search.
	const guildIds = args.guild
		? [await resolveGuild(env, args.guild)]
		: (await discordGuilds(env)).map((g) => g.id);
	if (guildIds.length === 0) {
		throw new ProviderError(
			'The Discord account has not joined any servers, so there is nothing to search.'
		);
	}

	const { sort_by, sort_order } = sortParams(args.sort);
	const params = new URLSearchParams({
		content: args.query,
		sort_by,
		sort_order,
		limit: String(Math.min(args.limit, MAX_RESULTS)),
		include_nsfw: 'false'
	});
	// Time window via the documented min_id param (snowflake). An earlier
	// version put an `after:<snowflake>` token inside content — Discord's
	// REST search ignores operators embedded that way (0 hits where the
	// unfiltered query had 2435); min_id is the API's own range filter.
	const minId = timeFilterSnowflake(args.time);
	if (minId) params.set('min_id', minId);
	if (args.channelId) params.set('channel_id', args.channelId);

	const settled = await Promise.allSettled(
		guildIds.map(async (guildId) => {
			const res = await discordGet(env, `/guilds/${guildId}/messages/search?${params.toString()}`);
			const data = JSON.parse(res.body) as RawSearchResponse;
			return flattenHits(data.messages ?? []).map((m) => mapMessage(m, guildId));
		})
	);

	const results: SearchResult[] = [];
	const failures: string[] = [];
	// Round-robin across guilds so no single server dominates the merged list,
	// preserving each guild's own relevance order within its slice.
	const perGuild = settled.map((s) =>
		s.status === 'fulfilled' ? s.value : (failures.push(String(s.reason?.message ?? s.reason)), [])
	);
	for (let i = 0; i < Math.max(0, ...perGuild.map((r) => r.length)); i++) {
		for (const guildResults of perGuild) {
			if (guildResults[i]) results.push(guildResults[i]);
		}
	}
	if (results.length === 0 && failures.length > 0) {
		throw new ProviderError(`Discord search failed in every server: ${failures.join(' | ')}`);
	}

	const maxLen = 2000; // Discord messages are already short; trim defensively
	return results
		.slice(0, Math.max(args.limit, 0) || results.length)
		.map((r) => ({
			...r,
			text: r.text.length > maxLen ? `${r.text.slice(0, maxLen)}…` : r.text
		}));
}