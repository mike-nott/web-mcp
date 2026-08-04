// Ported from ayima-chat/src/lib/server/mcp/types.ts (McpSession slimmed to
// single-user: no userId/conversationId).

export interface JsonRpcRequest {
	jsonrpc: '2.0';
	id?: string | number | null;
	method: string;
	params?: unknown;
}

export interface JsonRpcSuccess {
	jsonrpc: '2.0';
	id: string | number | null;
	result: unknown;
}

export interface JsonRpcError {
	jsonrpc: '2.0';
	id: string | number | null;
	error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

/** Default when the client doesn't request a version we recognise. */
export const MCP_PROTOCOL_VERSION = '2025-03-26';
