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

	const id = body.id ?? null;

	if (body.method === 'initialize') {
		const requested = (body.params as { protocolVersion?: string } | undefined)?.protocolVersion;
		return jsonResponse(handleInitialize(id, requested));
	}

	if (body.method === 'notifications/initialized') {
		return new Response(null, { status: 202, headers: CORS_HEADERS });
	}

	const caps = detectCapabilities(env);

	switch (body.method) {
		case 'tools/list':
			return jsonResponse(handleToolsList(id, caps));
		case 'tools/call': {
			const validated = validateToolCall(body.params, caps);
			if (!validated.ok) {
				return jsonResponse(rpcError(id, validated.code, validated.message));
			}
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
			return jsonResponse({
				jsonrpc: '2.0',
				id,
				result: {
					content: [{ type: 'text', text: result.text }],
					...(result.isError ? { isError: true } : {})
				}
			});
		}
		case 'ping':
			return jsonResponse({ jsonrpc: '2.0', id, result: {} });
		default:
			return jsonResponse(
				rpcError(id, MCP_ERROR_CODES.METHOD_NOT_FOUND, `Unknown method: ${body.method}`)
			);
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname !== '/mcp') return new Response('Not Found', { status: 404 });
		switch (request.method) {
			case 'POST':
				return handlePost(request, env);
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
