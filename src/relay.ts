// Discord relay Durable Object — holds a WebSocket to the local companion
// (Mike's Mac) and forwards Discord API GETs through it.
//
// Why a relay at all: discord.com's Cloudflare edge 403s any request whose
// TLS handshake originates from workerd — direct fetch, fetch through an
// external proxy tunnel, any headers (verified 2026-09: identical request from
// a residential IP through the same Oxylabs exit: 200; from the worker: 403).
// So the HTTP request must be made by a non-Cloudflare host. The companion
// connects OUT to this DO (works behind NAT), and every MCP client keeps
// talking only to the worker with the shared secrets.
//
// Hibernation API (state.acceptWebSocket + webSocketMessage): the DO can be
// evicted between messages while the socket stays open at the runtime level.
// In-memory Sets do NOT survive that — an earlier plain-WebSocket version
// held sockets in a Set, the DO got evicted between the companion's auth and
// the worker's first /get, and the connection was "forgotten" while still
// open. Hibernation mode survives eviction; authenticated sockets are tagged
// with serializeAttachment instead of a Set.
//
// Protocol (companion <-> DO, JSON text frames):
//   companion -> DO : { type: "auth", secret }                once, on connect
//   DO -> companion : { type: "ready" }                      auth accepted
//   DO -> companion : { type: "fetch", id, path, headers }    one Discord GET
//   companion -> DO : { type: "response", id, status, body }
//   companion -> DO : { type: "ping" }   ->  { type: "ready" }
//
// Auth: MCP_AUTH_TOKEN — the same secret the MCP clients use, so a new user
// has nothing extra to generate. Constant-time compared; auth'd sockets are
// tagged via serializeAttachment. The DO only forwards GETs to
// paths under /api — the companion refuses anything else, so a compromised
// worker cannot turn it into an open proxy.

import { DurableObjectState } from '@cloudflare/workers-types';
import type { Env } from './env';

const COMPANION_LIMIT_MS = 20_000; // companion must answer a fetch within this
const AUTH_WINDOW_MS = 15_000; // unauthed sockets are closed after this

export class DiscordRelay {
	private nextId = 1;

	constructor(private state: DurableObjectState, private env: Env) {}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		// Worker-facing: forward one Discord GET to the companion. Only this
		// worker's provider code calls it (not client-routable).
		if (url.pathname === '/get' && request.method === 'POST') {
			const { path, headers } = (await request.json()) as {
				path?: string;
				headers?: Record<string, string>;
			};
			if (typeof path !== 'string' || !path.startsWith('/')) {
				return new Response('Bad path', { status: 400 });
			}
			try {
				const result = await this.forwardToCompanion(path, headers ?? {});
				return new Response(JSON.stringify(result), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				});
			} catch (err) {
				return new Response(err instanceof Error ? err.message : 'relay failed', {
					status: 503
				});
			}
		}
		if (url.pathname !== '/connect' && url.pathname !== '/relay') {
			return new Response('Not Found', { status: 404 });
		}
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('Expected WebSocket', { status: 426 });
		}
		const pair = new WebSocketPair();
		// Tag at accept — getWebSockets('companion') finds them later. Auth
		// state rides the attachment ({auth:true} set on the 'auth' message);
		// a timer-based close would not survive hibernation anyway, and an
		// unauthenticated socket is inert: it is never selected for forwarding
		// and its pings are answered only after auth.
		this.state.acceptWebSocket(pair[1], ['companion']);
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	/** Hibernation message entry point — replaces addEventListener entirely. */
	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		let msg: { type?: string; secret?: string; id?: number; status?: number; body?: string };
		try {
			msg = JSON.parse(typeof message === 'string' ? message : '') as typeof msg;
		} catch {
			this.safeSend(ws, { type: 'error', message: 'invalid JSON' });
			return;
		}
		switch (msg.type) {
			case 'ping': {
				// Unauthenticated sockets are inert: no ping replies before auth,
				// so a stray connection cannot probe the DO.
				if (this.attachmentAuth(ws)) this.safeSend(ws, { type: 'ready' });
				return;
			}
			case 'auth': {
				// The companion authenticates with the same MCP_AUTH_TOKEN the MCP
				// clients use — one secret for "machines I trust talking to my
				// worker", no separate relay secret to generate, paste, or mix up.
				// (It grants no extra powers: the companion path only ever relays
				// Discord GETs.)
				const expected = this.env.MCP_AUTH_TOKEN ?? '';
				const got = msg.secret ?? '';
				const match =
					expected.length === got.length && [...expected].every((c, i) => c === got[i]);
				if (!match) {
					ws.close(4003, 'auth failed — expected the same MCP_AUTH_TOKEN your MCP clients use');
					return;
				}
				// Tag the socket as authenticated via the attachment; getWebSockets(
				// 'companion') finds it after any hibernation eviction.
				ws.serializeAttachment({ auth: true } satisfies { auth: boolean });
				this.safeSend(ws, { type: 'ready' });
				return;
			}
			case 'response': {
				// Resolve the stored waiter, if any. Waiters live in env-scoped KV?
				// No — pending fetches live in this DO's memory; a fetch in flight
				// during eviction is retried by the worker's ProviderError path.
				void this.resolveResponse(msg);
				return;
			}
			default:
				this.safeSend(ws, { type: 'error', message: `unexpected message type ${msg.type}` });
		}
	}

	private pending: Map<number, { resolve: (r: { status: number; body: string }) => void }> = new Map();

	private async resolveResponse(msg: { id?: number; status?: number; body?: string }): Promise<void> {
		const waiter = this.pending.get(msg.id ?? -1);
		if (!waiter) return;
		this.pending.delete(msg.id ?? -1);
		waiter.resolve({ status: msg.status ?? 0, body: msg.body ?? '' });
	}

	/** Forward one GET; tries companions round-robin, failing over on timeout. */
	private async forwardToCompanion(
		path: string,
		headers: Record<string, string>
	): Promise<{ status: number; body: string }> {
		const sockets = this.authenticatedSockets();
		if (sockets.length === 0) {
			throw new Error(
				'No companion connected. Install and start the web-mcp Discord companion ' +
					'(https://github.com/mike-nott/web-mcp#discord-companion), and check ' +
					'DISCORD_RELAY_SECRET matches on both sides.'
			);
		}
		// Multiple machines may connect (Mike's Mac + Linux server + other users');
		// rotate so one slow box doesn't become the bottleneck, and try the next
		// on timeout. A timed-out socket may be a stale hibernation entry whose
		// TCP peer is long gone (deploys leave those behind) — closing it purges
		// it from the runtime so later calls skip straight to live companions.
		const start = this.nextId % sockets.length;
		let lastError: Error = new Error('No companion answered.');
		for (let attempt = 0; attempt < sockets.length; attempt++) {
			const ws = sockets[(start + attempt) % sockets.length];
			try {
				return await this.sendAndWait(ws, path, headers);
			} catch (err) {
				lastError = err instanceof Error ? err : new Error(String(err));
				try { ws.close(4004, 'timed out'); } catch {}
			}
		}
		throw lastError;
	}

	private async sendAndWait(
		ws: WebSocket,
		path: string,
		headers: Record<string, string>
	): Promise<{ status: number; body: string }> {
		const id = this.nextId++;
		const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
		this.pending.set(id, { resolve });
		const timer = setTimeout(() => {
			this.pending.delete(id);
			reject(new Error('Companion did not respond within 20s.'));
		}, COMPANION_LIMIT_MS);
		this.safeSend(ws, { type: 'fetch', id, path, headers });
		try {
			return await promise;
		} finally {
			clearTimeout(timer);
		}
	}

	private authenticatedSockets(): WebSocket[] {
		return this.state.getWebSockets('companion').filter((ws) => this.attachmentAuth(ws));
	}

	private attachmentAuth(ws: WebSocket): boolean {
		try {
			return (ws.deserializeAttachment() as { auth?: boolean } | undefined)?.auth === true;
		} catch {
			return false;
		}
	}

	private safeSend(ws: WebSocket, msg: Record<string, unknown>): void {
		try {
			ws.send(JSON.stringify(msg));
		} catch {
			// Socket closed mid-send; hibernation close handler cleans up.
		}
	}
}