# web-mcp

Private MCP server on Cloudflare Workers giving agent sessions (Claude Code, OpenClaw) access to walled web content — the practitioner discussion layer that search engines can't reach.

**Phase 1 sources:** Reddit (official Data API, free tier) + X (TwitterAPI.io).
**Phase 2 candidates:** Discord (local Playwright, separate component), FireCrawl (arbitrary bot-blocked pages).

## Tools

| Tool | Purpose |
|------|---------|
| `social_search` | Search Reddit/X with time windows, native operators, engagement signals |
| `get_thread` | Pull a full scored comment/reply tree for a post or tweet |

No LLM in the worker — raw platform signals (scores, authors, dates) flow to the calling model.

## Architecture

```
Agent session ──MCP (Streamable HTTP + bearer token)──▶ Worker ──▶ Reddit API
                                                          │        TwitterAPI.io
                                                          ▼
                                                    KV: sessions, cache,
                                                    reddit token, X budget
```

- JSON-RPC 2.0 dispatch ported from ayima-chat's hand-rolled MCP transport (official SDK has no Workers support)
- KV cache: searches 1h, threads 15min
- X daily call ceiling (`X_DAILY_CALL_LIMIT`, default 500/day) — exhaustion returns a readable `isError` tool result
- Sessions: KV, 1h sliding TTL

## Setup

```bash
npm install
# .dev.vars holds local secrets (gitignored): MCP_AUTH_TOKEN, REDDIT_CLIENT_ID,
# REDDIT_CLIENT_SECRET, TWITTERAPI_IO_KEY
npm run dev            # local at http://localhost:8787/mcp
npm run typecheck
```

## Deploy (Nott account)

```bash
CLOUDFLARE_ACCOUNT_ID=258b070a59a9d28eee9b778148f4b743 wrangler kv namespace create KV
# paste the returned id into wrangler.toml, then:
echo "<value>" | CLOUDFLARE_ACCOUNT_ID=258b070a59a9d28eee9b778148f4b743 wrangler secret put MCP_AUTH_TOKEN
# ...repeat for REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, TWITTERAPI_IO_KEY
npm run deploy
```

## Register in Claude Code

```bash
claude mcp add --transport http --scope user web-mcp https://web-mcp.<subdomain>.workers.dev/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

Claude Code loads MCP servers at startup — restart the session after adding.
