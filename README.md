# Web-MCP

A private MCP server on Cloudflare Workers that gives your AI agent sessions (Claude Code, or any MCP client) access to walled web content — the practitioner discussion layer on Reddit and X that search engines can't reach, plus ordinary pages that block bots outright.

Deploy it once to your own Cloudflare account, register one URL + bearer token in your MCP clients, and every agent session can search social discussions, pull full scored comment threads, and read pages that normal fetching can't.

## Tools

| Tool | Purpose |
|------|---------|
| `find_communities` | Find which subreddits actually discuss a topic, with subscriber counts |
| `social_search` | Search Reddit/X — time windows, native search operators, engagement signals (scores, comment counts, authors, dates) |
| `get_thread` | Pull a full scored comment/reply tree for any post or tweet (bare id or URL) |
| `fetch_page` | Read pages behind bot protection, JavaScript-rendered shells, and PDFs |

The intended research chain:

```
find_communities("local llm")  →  social_search scoped to r/LocalLLaMA  →  get_thread on the best hits
```

Deliberately minimal: four tools, no LLM in the worker, no ranking or synthesis. Raw signals flow straight to the calling model, which does its own reasoning. (A big multi-tool surface bloats MCP clients' context windows — a few well-described tools route better.)

## Architecture

```
Agent session ──MCP (Streamable HTTP + bearer token)──▶ Worker ──▶ Reddit Data API (free)
                                                          │        TwitterAPI.io (~$0.15/1k tweets)
                                                          │        FireCrawl (1–5 credits/page)
                                                          ▼
                                                    Workers KV: sessions, response cache,
                                                    reddit token, daily budgets
```

`fetch_page` escalates rather than defaulting to the paid path:

```
fetch_page(url) ──▶ plain fetch + HTMLRewriter extraction        FREE
                         │
                    blocked / challenge page / JS shell / PDF?
                         │
                         └─▶ FireCrawl scrape (proxy: auto)      1 credit, 5 if enhanced proxy needed
```

The `tier` field in the response says which path served it. Crucially, a page that can't be retrieved returns an explicit error — never the challenge page's own HTML, which is the common failure that leads agents to hallucinate from an error page.

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

### 3. Get a FireCrawl key (optional, for `fetch_page` escalation)

Sign up at [firecrawl.dev](https://firecrawl.dev) and copy your API key. `fetch_page` works without it for pages that aren't blocked — it only needs FireCrawl when a page is genuinely walled, so the key is optional but recommended. Costs 1 credit per scrape, up to 5 when the enhanced proxy is needed to defeat stronger bot protection.

### 4. Generate your bearer token

```bash
echo "webmcp_$(openssl rand 32 | base64 | tr '+/' '-_' | tr -d '=\n')"
```

Keep it somewhere safe — it's the only key your MCP clients need.

### 5. Local dev (optional)

```bash
npm install
cat > .dev.vars <<'EOF'
MCP_AUTH_TOKEN=<your token>
REDDIT_CLIENT_ID=<from step 1>
REDDIT_CLIENT_SECRET=<from step 1>
TWITTERAPI_IO_KEY=<from step 2>
FIRECRAWL_API_KEY=<from step 3, optional>
EOF
npm run dev        # serves http://localhost:8787/mcp
npm run typecheck
```

### 6. Deploy to your Cloudflare account

```bash
# find your account id: npx wrangler whoami
export CLOUDFLARE_ACCOUNT_ID=<your-account-id>

npx wrangler kv namespace create KV
# paste the returned id into wrangler.toml under [[kv_namespaces]]

echo "<value>" | npx wrangler secret put MCP_AUTH_TOKEN
echo "<value>" | npx wrangler secret put REDDIT_CLIENT_ID
echo "<value>" | npx wrangler secret put REDDIT_CLIENT_SECRET
echo "<value>" | npx wrangler secret put TWITTERAPI_IO_KEY
echo "<value>" | npx wrangler secret put FIRECRAWL_API_KEY   # optional

npm run deploy
```

The free Workers plan is fine — this fits comfortably inside its limits for personal use.

### 7. Register in your MCP client

```bash
claude mcp add --transport http --scope user web-mcp https://web-mcp.<your-subdomain>.workers.dev/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

Claude Code loads MCP servers at startup — restart your session after adding. Any other MCP client works the same way: Streamable HTTP endpoint + Authorization header.

## Notes

- **Costs:** Reddit is free (official API free tier, 1000 req/10min). X costs ~$0.15/1k tweets via TwitterAPI.io. FireCrawl charges 1–5 credits only when a page is actually blocked — open pages are served free by the direct tier. Daily ceilings (`X_DAILY_CALL_LIMIT`, `FIRECRAWL_DAILY_CALL_LIMIT`) cap worst-case spend and return a readable message when hit. The worker itself runs free.
- **Search tips:** Reddit and X use keyword matching, not semantic search — short keyword queries beat natural-language questions, and scoping to a subreddit is the single biggest quality lever (use `find_communities` when you don't know which one). The tool descriptions teach the calling model this.
- **TwitterAPI.io is a third-party service** — cheaper than the official X API by ~30x, but it's grey-market data access. The provider layer is abstracted (`src/providers/`) so you can swap in the official X API if you prefer.
- **Privacy:** this is designed as a *private, single-user* server — one shared token, no user accounts. Don't publish your worker URL + token together.

## Next steps / future development

Planned or under consideration:

- **Discord** — search across servers you're a member of. Discord has no read API for this, so the likely shape is a small local companion process (browser-driven, residential IP) rather than a worker provider — separate component, same MCP pattern.
- **Exa** — optional semantic search over the open web, for cases where lexical keyword matching isn't enough.
- More sources as the walls go up.

Ideas and suggestions welcome via issues.

## License

[MIT](LICENSE)
