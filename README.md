# Web-MCP

A private MCP server on Cloudflare Workers that gives your AI agent sessions (Claude Code, or any MCP client) access to walled web content — the practitioner discussion layer on Reddit and X that search engines can't reach and LLMs get blocked from.

Deploy it once to your own Cloudflare account, register one URL + bearer token in your MCP clients, and every agent session can search social discussions and pull full scored comment threads.

## Tools

| Tool | Purpose |
|------|---------|
| `social_search` | Search Reddit/X — time windows, native search operators, engagement signals (scores, comment counts, authors, dates) |
| `get_thread` | Pull a full scored comment/reply tree for any post or tweet (bare id or URL) |

Deliberately minimal: two tools, no LLM in the worker, no ranking or synthesis. Raw platform signals flow straight to the calling model, which does its own reasoning. (A big multi-tool surface bloats MCP clients' context windows — two well-described tools route better.)

## Architecture

```
Agent session ──MCP (Streamable HTTP + bearer token)──▶ Worker ──▶ Reddit Data API (free)
                                                          │        TwitterAPI.io (~$0.15/1k tweets)
                                                          ▼
                                                    Workers KV: sessions, response cache,
                                                    reddit token, X daily budget
```

- Hand-rolled JSON-RPC 2.0 / Streamable HTTP transport (the official MCP SDK has Node-only dependencies and doesn't run on Workers)
- KV response cache: searches 1h, threads 15min — repeated queries across sessions cost nothing
- X daily call ceiling (`X_DAILY_CALL_LIMIT`, default 500/day) — exhaustion returns a readable tool result, not a crash
- Reddit uses the official Data API free tier via app-only OAuth: authenticated datacenter traffic is Reddit's sanctioned path, with a descriptive User-Agent and rate-header backoff

## Setup

### 1. Create a Reddit app (free)

1. Go to [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) while logged in
2. Click **create another app…**, choose type **script** ("personal use script")
3. Name it anything; redirect URI can be `http://localhost` (unused)
4. Note the **client ID** (short string under the app name) and **secret**
5. Edit `REDDIT_USER_AGENT` in `wrangler.toml` to identify *your* app, e.g. `cf-worker:web-mcp:v1 (by /u/yourusername)` — Reddit requires a descriptive, unique UA

### 2. Sign up for TwitterAPI.io

1. Create an account at [twitterapi.io](https://twitterapi.io/) — you get an API key instantly, no X developer approval
2. Add credits (pay-per-use, ~$0.15 per 1,000 tweets; there's a small free allowance to test with, throttled to one request per 5 seconds until you add credits)

### 3. Generate your bearer token

```bash
echo "webmcp_$(openssl rand 32 | base64 | tr '+/' '-_' | tr -d '=\n')"
```

Keep it somewhere safe — it's the only key your MCP clients need.

### 4. Local dev (optional)

```bash
npm install
cat > .dev.vars <<'EOF'
MCP_AUTH_TOKEN=<your token>
REDDIT_CLIENT_ID=<from step 1>
REDDIT_CLIENT_SECRET=<from step 1>
TWITTERAPI_IO_KEY=<from step 2>
EOF
npm run dev        # serves http://localhost:8787/mcp
npm run typecheck
```

### 5. Deploy to your Cloudflare account

```bash
# find your account id: npx wrangler whoami
export CLOUDFLARE_ACCOUNT_ID=<your-account-id>

npx wrangler kv namespace create KV
# paste the returned id into wrangler.toml under [[kv_namespaces]]

echo "<value>" | npx wrangler secret put MCP_AUTH_TOKEN
echo "<value>" | npx wrangler secret put REDDIT_CLIENT_ID
echo "<value>" | npx wrangler secret put REDDIT_CLIENT_SECRET
echo "<value>" | npx wrangler secret put TWITTERAPI_IO_KEY

npm run deploy
```

The free Workers plan is fine — this fits comfortably inside its limits for personal use.

### 6. Register in your MCP client

```bash
claude mcp add --transport http --scope user web-mcp https://web-mcp.<your-subdomain>.workers.dev/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

Claude Code loads MCP servers at startup — restart your session after adding. Any other MCP client works the same way: Streamable HTTP endpoint + Authorization header.

## Notes

- **Costs:** Reddit is free (official API free tier, 1000 req/10min). X costs ~$0.15/1k tweets via TwitterAPI.io; the daily ceiling caps worst-case spend. The worker itself runs free.
- **TwitterAPI.io is a third-party service** — cheaper than the official X API by ~30x, but it's grey-market data access. The provider layer is abstracted (`src/providers/`) so you can swap in the official X API if you prefer.
- **Privacy:** this is designed as a *private, single-user* server — one shared token, no user accounts. Don't publish your worker URL + token together.

## Next steps / future development

Planned or under consideration:

- **FireCrawl provider** — a `fetch_page` tool for arbitrary bot-blocked pages via [FireCrawl](https://firecrawl.dev)'s cloud API, extending coverage beyond social platforms to any walled page you can name.
- **Discord** — search across servers you're a member of. Discord has no read API for this, so the likely shape is a small local companion process (browser-driven, residential IP) rather than a worker provider — separate component, same MCP pattern.
- More sources as the walls go up.

Ideas and suggestions welcome via issues.

## License

[MIT](LICENSE)
