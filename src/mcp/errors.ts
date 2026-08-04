// Ported from ayima-chat/src/lib/server/mcp/errors.ts, app-specific codes
// trimmed to the two this server uses.

import type { JsonRpcError } from './types';

export const MCP_ERROR_CODES = {
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,
	UNAUTHORIZED: -32001,
	PROVIDER_ERROR: -32003
} as const;

export function rpcError(
	id: string | number | null,
	code: number,
	message: string,
	data?: unknown
): JsonRpcError {
	return {
		jsonrpc: '2.0',
		id,
		error: { code, message, ...(data !== undefined ? { data } : {}) }
	};
}
