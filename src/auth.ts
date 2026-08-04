// Single-secret bearer auth. Both sides are SHA-256 hashed before comparison so
// the equality check runs over fixed-length digests (timing-safe in practice),
// following the hash-at-rest pattern from ayima-chat/src/lib/server/crypto/token.ts.

import type { Env } from './env';
import { MCP_ERROR_CODES } from './mcp/errors';

async function sha256Hex(value: string): Promise<string> {
	const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

export async function authenticateRequest(
	env: Env,
	authHeader: string | null
): Promise<{ ok: true } | { ok: false; code: number; message: string }> {
	if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
		return {
			ok: false,
			code: MCP_ERROR_CODES.UNAUTHORIZED,
			message: 'Missing bearer token'
		};
	}
	const token = authHeader.slice(7).trim();
	if (!env.MCP_AUTH_TOKEN) {
		return {
			ok: false,
			code: MCP_ERROR_CODES.INTERNAL_ERROR,
			message: 'MCP_AUTH_TOKEN secret not configured'
		};
	}
	const [given, expected] = await Promise.all([
		sha256Hex(token),
		sha256Hex(env.MCP_AUTH_TOKEN)
	]);
	if (given !== expected) {
		return { ok: false, code: MCP_ERROR_CODES.UNAUTHORIZED, message: 'Invalid token' };
	}
	return { ok: true };
}
