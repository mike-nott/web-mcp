// web-mcp — thin MCP server (Streamable HTTP, JSON responses only) for walled
// web content. Dispatch shape ported from ayima-chat/src/routes/mcp/+server.ts:
// all errors are HTTP 200 JSON-RPC error bodies; initialize returns the
// Mcp-Session-Id header; notifications get 202; SSE is deliberately skipped —
// both tools return in a few seconds, and Claude Code accepts plain JSON on a
// POST that advertised text/event-stream.

import type { Env } from './env';
import type { JsonRpcRequest, JsonRpcResponse } from './mcp/types';
import { MCP_ERROR_CODES, rpcError } from './mcp/errors';
import { handleInitialize, handleToolsList, validateToolCall } from './mcp/handlers';
import {
	createMcpSession,
	deleteMcpSession,
	getMcpSession,
	touchMcpSession
} from './mcp/session';
import { authenticateRequest } from './auth';
import { runGetThread, runSocialSearch } from './tools';

const SESSION_HEADER = 'Mcp-Session-Id';

function jsonResponse(body: JsonRpcResponse, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'Content-Type': 'application/json', ...headers }
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
		// Session only — write nothing else; MCP clients handshake at every
		// startup and abandon most sessions.
		const session = await createMcpSession(env.KV);
		return jsonResponse(handleInitialize(id), { [SESSION_HEADER]: session.sessionId });
	}

	if (body.method === 'notifications/initialized') {
		return new Response(null, { status: 202 });
	}

	const sessionId = request.headers.get(SESSION_HEADER);
	if (!sessionId) {
		return jsonResponse(rpcError(id, MCP_ERROR_CODES.INVALID_REQUEST, 'Missing Mcp-Session-Id'));
	}
	const session = await getMcpSession(env.KV, sessionId);
	if (!session) {
		return jsonResponse(rpcError(id, MCP_ERROR_CODES.UNAUTHORIZED, 'Session not found or expired'));
	}
	await touchMcpSession(env.KV, session);

	switch (body.method) {
		case 'tools/list':
			return jsonResponse(handleToolsList(id));
		case 'tools/call': {
			const validated = validateToolCall(body.params);
			if (!validated.ok) {
				return jsonResponse(rpcError(id, validated.code, validated.message));
			}
			const result =
				validated.tool === 'social_search'
					? await runSocialSearch(env, validated.args)
					: await runGetThread(env, validated.args);
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

async function handleDelete(request: Request, env: Env): Promise<Response> {
	const auth = await authenticateRequest(env, request.headers.get('Authorization'));
	if (!auth.ok) return new Response('Unauthorized', { status: 401 });
	const sessionId = request.headers.get(SESSION_HEADER);
	if (sessionId) await deleteMcpSession(env.KV, sessionId);
	return new Response(null, { status: 204 });
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname !== '/mcp') return new Response('Not Found', { status: 404 });
		switch (request.method) {
			case 'POST':
				return handlePost(request, env);
			case 'DELETE':
				return handleDelete(request, env);
			default:
				return new Response('Method Not Allowed', { status: 405 });
		}
	}
} satisfies ExportedHandler<Env>;
