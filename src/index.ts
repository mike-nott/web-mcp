// web-mcp — thin MCP server (Streamable HTTP, JSON responses only) for walled
// web content.
//
// Deliberately STATELESS: no sessions. The bearer token is the only thing that
// grants access, so a session id would add no security — and requiring one
// silently breaks clients that don't echo the header back (Jan, for one:
// initialize succeeded, every later call returned "Missing Mcp-Session-Id", and
// because that is an HTTP 200 the user just saw a server with no tools). The
// MCP spec makes session management optional for exactly this reason.
//
// All errors are HTTP 200 JSON-RPC error bodies. SSE is skipped — every tool
// returns in a few seconds, and clients accept plain JSON on a POST that
// advertised text/event-stream.

import type { Env } from './env';
import type { JsonRpcRequest, JsonRpcResponse } from './mcp/types';
import { MCP_ERROR_CODES, rpcError } from './mcp/errors';
import { handleInitialize, handleToolsList, validateToolCall } from './mcp/handlers';
import { authenticateRequest } from './auth';
import { detectCapabilities } from './capabilities';
import {
	runFetchPage,
	runFindCommunities,
	runGetThread,
	runSocialSearch,
	runWebSearch
} from './tools';

// Wildcard is safe: CORS is not the access control here — the bearer token is,
// and a browser cannot attach it without the user configuring the client.
// Without this, any client whose HTTP layer runs in a browser engine (Electron
// or Tauri renderers) fails its preflight before the real request is ever sent.
const CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
	'Access-Control-Allow-Headers':
		'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version',
	'Access-Control-Max-Age': '86400'
};

function jsonResponse(body: JsonRpcResponse): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
	});
}

const SSE_HEADERS: Record<string, string> = {
	'Content-Type': 'text/event-stream; charset=utf-8',
	'Cache-Control': 'no-cache',
	// Required on Workers: without it, compression buffers the stream and
	// nothing reaches the client until the response ends.
	'Content-Encoding': 'identity',
	...CORS_HEADERS
};

const KEEPALIVE_MS = 15_000;
const GET_STREAM_MAX_MS = 300_000; // bounded so an invocation can't live forever

function wantsSse(request: Request): boolean {
	return (request.headers.get('Accept') ?? '').includes('text/event-stream');
}

/**
 * Streams one JSON-RPC response as SSE, with `: keepalive` comment frames while
 * the work is in flight. The heartbeats reset client idle timeouts, which is
 * what keeps long fetch_page transcript jobs alive against a 30s client limit.
 *
 * No `event:`/`id:` fields (no resumability offered) and no
 * notifications/progress — the spec says to send those only for a
 * client-supplied progressToken, and these tools have no intermediate progress
 * worth reporting. A heartbeat is honest; invented progress is not.
 */
function sseResponse(work: () => Promise<JsonRpcResponse>): Response {
	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const enc = new TextEncoder();
	let closed = false;

	const write = (s: string): Promise<void> =>
		closed
			? Promise.resolve()
			: writer.write(enc.encode(s)).catch(() => {
					// Client disconnected — stop writing, let the work settle.
					closed = true;
				});

	const heartbeat = setInterval(() => void write(': keepalive\n\n'), KEEPALIVE_MS);

	void (async () => {
		let response: JsonRpcResponse;
		try {
			response = await work();
		} catch (err) {
			response = rpcError(
				null,
				MCP_ERROR_CODES.INTERNAL_ERROR,
				err instanceof Error ? err.message : String(err)
			);
		}
		clearInterval(heartbeat);
		await write(`data: ${JSON.stringify(response)}\n\n`);
		await writer.close().catch(() => {});
	})();

	return new Response(readable, { status: 200, headers: SSE_HEADERS });
}

/**
 * The stream a client opens with GET for server-initiated messages. This server
 * has none to push, so it simply stays alive on keepalives — which is what the
 * client is waiting for. Bounded; clients reconnect, which is normal for SSE.
 */
function sseKeepaliveStream(): Response {
	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const enc = new TextEncoder();
	let closed = false;

	const write = (s: string): Promise<void> =>
		closed
			? Promise.resolve()
			: writer.write(enc.encode(s)).catch(() => {
					closed = true;
				});

	void (async () => {
		await write(': connected\n\n');
		const deadline = Date.now() + GET_STREAM_MAX_MS;
		while (!closed && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, KEEPALIVE_MS));
			await write(': keepalive\n\n');
		}
		await writer.close().catch(() => {});
	})();

	return new Response(readable, { status: 200, headers: SSE_HEADERS });
}

/** Produces the JSON-RPC response; the caller decides JSON vs SSE delivery. */
async function dispatch(body: JsonRpcRequest, env: Env): Promise<JsonRpcResponse> {
	const id = body.id ?? null;

	if (body.method === 'initialize') {
		const requested = (body.params as { protocolVersion?: string } | undefined)?.protocolVersion;
		return handleInitialize(id, requested);
	}

	const caps = detectCapabilities(env);

	switch (body.method) {
		case 'tools/list':
			return handleToolsList(id, caps);
		case 'tools/call': {
			const validated = validateToolCall(body.params, caps);
			if (!validated.ok) return rpcError(id, validated.code, validated.message);
			let result;
			switch (validated.tool) {
				case 'social_search':
					result = await runSocialSearch(env, validated.args);
					break;
				case 'get_thread':
					result = await runGetThread(env, validated.args);
					break;
				case 'fetch_page':
					result = await runFetchPage(env, validated.args);
					break;
				case 'find_communities':
					result = await runFindCommunities(env, validated.args);
					break;
				case 'web_search':
					result = await runWebSearch(env, validated.args);
					break;
			}
			return {
				jsonrpc: '2.0',
				id,
				result: {
					content: [{ type: 'text', text: result.text }],
					...(result.isError ? { isError: true } : {})
				}
			};
		}
		case 'ping':
			return { jsonrpc: '2.0', id, result: {} };
		default:
			return rpcError(id, MCP_ERROR_CODES.METHOD_NOT_FOUND, `Unknown method: ${body.method}`);
	}
}

async function handlePost(request: Request, env: Env): Promise<Response> {
	const auth = await authenticateRequest(env, request.headers.get('Authorization'));
	if (!auth.ok) return jsonResponse(rpcError(null, auth.code, auth.message));

	let body: JsonRpcRequest;
	try {
		body = (await request.json()) as JsonRpcRequest;
	} catch {
		return jsonResponse(rpcError(null, MCP_ERROR_CODES.PARSE_ERROR, 'Invalid JSON'));
	}
	if (body?.jsonrpc !== '2.0' || typeof body.method !== 'string') {
		return jsonResponse(
			rpcError(body?.id ?? null, MCP_ERROR_CODES.INVALID_REQUEST, 'Not a JSON-RPC 2.0 request')
		);
	}

	// A notification has no response at all — answering one would violate the spec.
	if (body.method === 'notifications/initialized') {
		return new Response(null, { status: 202, headers: CORS_HEADERS });
	}

	// Clients that advertise text/event-stream get the streaming transport;
	// everything else keeps the plain JSON body it has always had.
	return wantsSse(request)
		? sseResponse(() => dispatch(body, env))
		: jsonResponse(await dispatch(body, env));
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname !== '/mcp') return new Response('Not Found', { status: 404 });
		switch (request.method) {
			case 'POST':
				return handlePost(request, env);
			case 'GET': {
				// The server-initiated message stream. We have nothing to push, but
				// clients open this and wait on it — returning 405 made Jan tear the
				// connection down and reconnect in a loop.
				const auth = await authenticateRequest(env, request.headers.get('Authorization'));
				if (!auth.ok) {
					return new Response('Unauthorized', { status: 401, headers: CORS_HEADERS });
				}
				if (!wantsSse(request)) {
					return new Response('Method Not Allowed', { status: 405, headers: CORS_HEADERS });
				}
				return sseKeepaliveStream();
			}
			case 'OPTIONS':
				return new Response(null, { status: 204, headers: CORS_HEADERS });
			case 'DELETE':
				// Nothing to tear down — kept so clients that send it on shutdown
				// get a clean answer rather than a 405.
				return new Response(null, { status: 204, headers: CORS_HEADERS });
			default:
				return new Response('Method Not Allowed', { status: 405, headers: CORS_HEADERS });
		}
	}
} satisfies ExportedHandler<Env>;
