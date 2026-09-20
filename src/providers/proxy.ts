// Discord request transport — relay DO edition.
//
// History (the README has the full saga): every path that makes
// the HTTP request originate from a Cloudflare Worker is blocked by Discord's
// Cloudflare edge with a bare 403 — direct fetch, fetch via Oxylabs CONNECT
// tunnel, even with perfect browser headers. The block is on workerd's TLS
// fingerprint, not the token, headers, or exit IP (verified 2026-09: the same
// request via curl from a residential IP through the same Oxylabs exit: 200).
//
// So the request is relayed to the local companion on Mike's Mac, which holds
// an outbound WebSocket to the DiscordRelay Durable Object (src/relay.ts). The
// DO forwards { path, headers } down the socket; the companion runs the real
// HTTPS request and returns the body. The companion authenticates with the
// MCP_AUTH_TOKEN (same as MCP clients) and refuses anything that is not a GET
// to discord.com/api — it is a dumb relay, not an open proxy.

import type { Env } from '../env';

export interface RelayResult {
	status: number;
	body: string;
}

/**
 * Forwards one Discord API GET through the relay DO to the local companion.
 * `path` is the path+query under https://discord.com/api/v10.
 */
export async function relayDiscordGet(
	env: Env,
	path: string,
	headers: Record<string, string>
): Promise<RelayResult> {
	// No separate relay secret: the companion authenticates with MCP_AUTH_TOKEN
	// inside the DO; from here the only requirement is that a Discord token is
	// configured (capability gate guarantees it, checked defensively anyway).
	const id = env.DISCORD_RELAY.idFromName('singleton');
	const stub = env.DISCORD_RELAY.get(id);
	// The DO exposes its own fetch surface; we call its internal handler via a
	// service-binding-style POST to /get, which the DO routes to discordGet().
	const res = await stub.fetch('https://do/get', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ path, headers })
	});
	if (!res.ok) {
		throw new Error(`Relay DO error (HTTP ${res.status}): ${await res.text()}`);
	}
	return (await res.json()) as RelayResult;
}

/**
 * Browser-context headers for Discord's user-token REST gate. A bare
 * Authorization header is 403'd even with a valid token; X-Super-Properties is
 * the web client's base64 build metadata.
 */
export function discordHeaders(env: Env): Record<string, string> {
	const superProps = btoa(
		JSON.stringify({
			os: 'Mac OS X',
			browser: 'Chrome',
			device: '',
			system_locale: 'en-US',
			browser_version: '138.0.0.0',
			os_version: '10.15.7',
			release_channel: 'stable',
			client_build_number: 462018,
			engine: 'Blink'
		})
	);
	return {
		Authorization: env.DISCORD_USER_TOKEN,
		Accept: 'application/json',
		'Accept-Language': 'en-US,en;q=0.9',
		'User-Agent':
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
			'Chrome/138.0.0.0 Safari/537.36',
		'X-Discord-Locale': 'en-US',
		'X-Super-Properties': superProps,
		'X-Discord-Timezone': 'Europe/London',
		Referer: 'https://discord.com/channels/@me',
		Origin: 'https://discord.com'
	};
}