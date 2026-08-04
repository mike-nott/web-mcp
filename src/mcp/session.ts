// Ported from ayima-chat/src/lib/server/mcp/session.ts (conversationId/userId
// dropped — single shared token, nothing user-specific to carry).

import type { McpSession } from './types';

const KEY_PREFIX = 'mcp:session:';
const SESSION_TTL_SECONDS = 3600;

export async function createMcpSession(kv: KVNamespace): Promise<McpSession> {
	const sessionId = `sess_${crypto.randomUUID().replace(/-/g, '')}`;
	const now = new Date().toISOString();
	const session: McpSession = { sessionId, createdAt: now, lastUsedAt: now };
	await kv.put(KEY_PREFIX + sessionId, JSON.stringify(session), {
		expirationTtl: SESSION_TTL_SECONDS
	});
	return session;
}

export async function getMcpSession(
	kv: KVNamespace,
	sessionId: string
): Promise<McpSession | null> {
	const raw = await kv.get(KEY_PREFIX + sessionId);
	return raw ? (JSON.parse(raw) as McpSession) : null;
}

export async function touchMcpSession(kv: KVNamespace, session: McpSession): Promise<void> {
	const updated: McpSession = { ...session, lastUsedAt: new Date().toISOString() };
	await kv.put(KEY_PREFIX + session.sessionId, JSON.stringify(updated), {
		expirationTtl: SESSION_TTL_SECONDS
	});
}

export async function deleteMcpSession(kv: KVNamespace, sessionId: string): Promise<void> {
	await kv.delete(KEY_PREFIX + sessionId);
}
