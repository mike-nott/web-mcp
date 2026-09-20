#!/usr/bin/env node
// web-mcp Discord companion — relays Discord API GETs from the Cloudflare
// worker through this Mac's residential connection.
//
// Why this exists: discord.com's Cloudflare edge 403s any request whose TLS
// handshake comes from workerd, no matter the exit IP or headers. So the worker
// (which every MCP client talks to) forwards Discord GETs here over a
// reverse WebSocket; this process performs the actual HTTPS request and
// returns the body. See src/relay.ts (DO) and src/providers/proxy.ts (worker side).
//
// Security model:
//   - Authenticates to the worker with MCP_AUTH_TOKEN (env or config file),
//   - Only ever performs GETs to https://discord.com/api/v10 — refuses any
//     other scheme, host, or method. A compromised worker cannot turn this
//     into an open proxy.
//   - The Discord token lives on Cloudflare; the worker sends it per-request
//     in the headers, and it is never written to disk here.
//
// Usage:
//   node companion.mjs                          # reads env vars / ~/.web-mcp-relay.json
//   RELAY_URL=wss://... node companion.mjs
//
// Run under launchd / a supervisor to keep it connected. Reconnects with
// backoff automatically; a 30s ping keeps NAT/firewall mappings alive.

import { readFileSync } from 'node:fs';

const CONFIG_PATH = process.env.RELAY_CONFIG ?? `${process.env.HOME}/.web-mcp-relay.json`;
const DEFAULT_URL = 'wss://web-mcp.nott-258.workers.dev/relay';

function loadConfig() {
	let file = {};
	try {
		file = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
	} catch {
		// No config file — env vars only.
	}
	return {
		url: process.env.RELAY_URL ?? file.url ?? DEFAULT_URL,
		// Same token the MCP clients use — one secret for "my machines talk to
		// my worker". No separate relay secret exists.
		secret:
			process.env.MCP_AUTH_TOKEN ??
			process.env.DISCORD_RELAY_SECRET ?? // legacy name, still accepted
			file.token ??
			file.secret ?? // legacy config field
			''
	};
}

const { url, secret } = loadConfig();
if (!secret) {
	console.error(`Missing MCP_AUTH_TOKEN (env var or "token" in ${CONFIG_PATH})`);
	process.exit(1);
}

const API_BASE = 'https://discord.com/api/v10';
let authenticated = false;
let backoffMs = 1000;
const MAX_BACKOFF_MS = 60_000;

function connect() {
	const ws = new WebSocket(url);
	const pingTimer = setInterval(() => {
		if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
	}, 30_000);

	ws.addEventListener('open', () => {
		console.log(`[relay] connected to ${url}`);
		ws.send(JSON.stringify({ type: 'auth', secret }));
	});

	ws.addEventListener('message', (evt) => void handleMessage(ws, evt.data));

	ws.addEventListener('close', (evt) => {
		clearInterval(pingTimer);
		authenticated = false;
		console.log(`[relay] closed (code ${evt.code}); reconnecting in ${backoffMs}ms`);
		setTimeout(connect, backoffMs);
		backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
	});

	ws.addEventListener('error', () => {
		// 'close' always follows 'error'; reconnection handled there.
	});
}

async function handleMessage(ws, raw) {
	let msg;
	try {
		msg = JSON.parse(raw);
	} catch {
		return;
	}
	if (msg.type === 'ready') {
		backoffMs = 1000; // successful auth resets backoff
		// The DO answers every 30s ping with 'ready' too — log the transition
		// into authenticated state once, not each ping.
		if (!authenticated) {
			authenticated = true;
			console.log('[relay] authenticated');
		}
		return;
	}
	console.log(`[relay] fetch #${msg.id} ${msg.path}`);

	let response;
	try {
		response = await performGet(msg.path, msg.headers);
	} catch (err) {
		console.log(`[relay] fetch #${msg.id} errored: ${err?.message ?? err}`);
		response = { status: 0, body: String(err?.message ?? err) };
	}
	console.log(`[relay] fetch #${msg.id} -> HTTP ${response.status}, ${response.body.length} bytes`);
	ws.send(
		JSON.stringify({
			type: 'response',
			id: msg.id,
			status: response.status,
			body: response.body
		})
	);
}

async function performGet(path, headers) {
	// Hard-scope the relay: GET only, discord.com API only. The worker sends
	// paths relative to the API root ('/users/...'); new URL() with a leading-
	// slash path DISCARDS the base's /api/v10 prefix, so resolve against the
	// origin and rebuild the API path explicitly.
	const target = new URL(path, 'https://discord.com');
	if (
		target.origin !== 'https://discord.com' ||
		target.protocol !== 'https:' ||
		typeof path !== 'string' ||
		!path.startsWith('/')
	) {
		throw new Error(`refusing target: ${String(path)}`);
	}
	target.pathname = `/api/v10${target.pathname}`;
	const res = await fetch(target, {
		method: 'GET',
		headers: {
			Authorization: headers['Authorization'] ?? '',
			Accept: 'application/json',
			'Accept-Language': 'en-US,en;q=0.9',
			'User-Agent':
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
				'Chrome/138.0.0.0 Safari/537.36',
			'X-Discord-Locale': 'en-US',
			...(headers['X-Super-Properties'] ? { 'X-Super-Properties': headers['X-Super-Properties'] } : {})
		},
		redirect: 'manual'
	});
	const body = await res.text();
	return { status: res.status, body: body.slice(0, 1_000_000) };
}

console.log(`[relay] starting; target ${url}`);
connect();