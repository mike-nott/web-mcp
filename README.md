# Web-MCP

**One MCP server that gives any AI agent the parts of the web it can't otherwise reach.**

Social platforms block LLM traffic. Ordinary pages sit behind Cloudflare challenges. Search engines return the marketing layer while the real answers sit in comment threads, and a video's actual content is locked inside its audio. Meanwhile a search-less local model can't look anything up at all.

Web-MCP closes all of that from a single endpoint. Deploy it once to your own Cloudflare account, register one URL and one token in your MCP clients, and every agent session — Claude Code, a local LLM, anything speaking MCP — gets the same reach.

```
find_communities("local llm")     → r/LocalLLaMA (792k members)
social_search(scoped to it)       → the threads practitioners actually wrote
get_thread(best hit)              → the scored comments, including the dissent
fetch_page(a blocked vendor page) → readable text, no 403
web_search("essays arguing X")    → pages whose keywords you could never guess
```

## What it does

| Tool | Purpose |
|------|---------|
| `find_communities` | Find which subreddits actually discuss a topic, with subscriber counts |
| `social_search` | Search Reddit / X / YouTube with engagement signals — scores, views, comment counts, authors, dates |
| `get_thread` | Pull a scored comment/reply tree for any post, tweet or video |
| `fetch_page` | Read bot-protected pages, JS-rendered shells, PDFs — and video transcripts |
| `web_search` | Open-web search in two modes: `keyword` (ordinary) and `semantic` (meaning-based, plus find-similar-by-URL) |

Five tools, no LLM in the worker, no ranking or synthesis. Raw signals flow straight to the calling model, which does the reasoning. A sprawling tool surface bloats MCP clients' context windows and confuses routing — a few well-described tools route better.

Three details that make it work in practice:

- **`fetch_page` escalates instead of defaulting to paid.** A free direct fetch handles open pages; only genuine walls cost a credit. And a page that can't be retrieved returns an *explicit error* rather than the challenge page's own HTML — the failure mode that otherwise has agents confidently summarising a Cloudflare interstitial.
- **Keyword search can query two independent engines and merge them.** Their indexes are largely disjoint, so recall roughly doubles — and where they overlap, one merged result carries Brave's publication date *and* Tavily's full page text, which neither engine returns alone.
- **Tools only appear when their provider is configured.** Your agent is never offered something it can't use.

## Pick your providers — everything is optional

**`MCP_AUTH_TOKEN` is the only required secret.** Every data source is independent: set the keys for what you want, skip the rest, and the tool surface adapts. Ask for something unconfigured and the error names the exact variable to set.

| You provide | You unlock | Cost |
|---|---|---|
| *(nothing)* | `fetch_page` on ordinary pages | Free |
| `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` | Reddit search & threads, plus `find_communities` | **Free** |
| `YOUTUBE_API_KEY` | YouTube search & comments | **Free** (~100 searches/day) |
| `TAVILY_API_KEY` | `web_search` keyword mode | **1,000 credits/month free**, then $0.008 |
| `TWITTERAPI_IO_KEY` | X search & threads | ~$0.15 / 1k tweets |
| `SUPADATA_API_KEY` | Video transcripts via `fetch_page` | 1 credit each |
| `FIRECRAWL_API_KEY` | `fetch_page` past bot protection, plus PDFs | 1–5 credits, only when blocked |
| `BRAVE_API_KEY` | `web_search` keyword mode (alternative/addition to Tavily) | ~$5 / 1k, no free tier since Feb 2026 |
| `EXA_API_KEY` | `web_search` semantic mode + find-similar | ~$0.007 / call |

**A useful free-only build exists:** Reddit + YouTube + Tavily costs nothing and still gives you community discovery, social search, comment threads, keyword web search and page fetching.

A Reddit-only install exposes exactly `social_search` (Reddit only), `get_thread`, `find_communities` and `fetch_page` — `web_search` simply isn't there.

## Architecture

```
Agent session ──MCP (Streamable HTTP + bearer)──▶ Worker ──▶ Reddit Data API      free
                                                     │        YouTube Data API     free
                                                     │        Tavily / Brave       keyword search
                                                     │        Exa                  semantic search
                                                     │        TwitterAPI.io        X
                                                     │        FireCrawl            bot-blocked pages
                                                     │        Supadata             video transcripts
                                                     ▼
                                               Workers KV — sessions, response cache,
                                               Reddit token, transcript jobs, daily budgets
```

`fetch_page` routes by URL and escalates only as needed:

```
fetch_page(url) ──▶ video URL? ──────────────────────────▶ transcript     1 credit
                         │
                         └─▶ plain fetch + HTMLRewriter                   FREE
                                  │
                             blocked / challenge / JS shell / PDF?
                                  │
                                  └─▶ FireCrawl (proxy: auto)             1 credit, 5 if enhanced
```

The `tier` field on every response says which path served it.

**Implementation notes**

- Hand-rolled JSON-RPC 2.0 over Streamable HTTP — the official MCP SDK has Node-only dependencies and doesn't run on Workers.
- KV response cache: searches 1h, threads 15min, pages 1h, communities 24h. Repeated queries cost nothing.
- Per-provider daily ceilings return a readable message when hit, never a crash. Set any to `0` to disable.
- Reddit uses the official Data API via app-only OAuth — authenticated datacenter traffic is Reddit's sanctioned path — with a descriptive User-Agent and rate-header backoff.
- Requests to non-public hosts (localhost, IP literals) are rejected before any fetch.

## Setup

### 1. Bearer token (required)

```bash
echo "webmcp_$(openssl rand 32 | base64 | tr '+/' '-_' | tr -d '=\n')"
```

This is the only credential your MCP clients need.

### 2. Provider keys (all optional — take what you want)

<details>
<summary><b>Reddit</b> — free, ~2 minutes</summary>

1. At [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps), click **create another app…** and choose type **script**
2. Redirect URI can be `http://localhost` (unused)
3. Copy the **client ID** (under the app name) and **secret**
4. Set `REDDIT_USER_AGENT` in `wrangler.toml` to identify your app, e.g. `cf-worker:web-mcp:v1 (by /u/yourusername)` — Reddit requires a unique, descriptive UA
</details>

<details>
<summary><b>YouTube</b> — free</summary>

At [console.cloud.google.com](https://console.cloud.google.com): create or pick a project → **APIs & Services → Library → "YouTube Data API v3" → Enable** → **Credentials → Create Credentials → API key**.

*If the API-restrictions dropdown is empty, the API isn't enabled on that project yet — the dropdown only lists enabled APIs.*

Quota note: YouTube *search* is capped around 100 calls/day in its own bucket, while metadata and comments cost 1 unit against a separate 10,000/day pool. Only search is scarce, and only search is budgeted here.
</details>

<details>
<summary><b>Keyword web search</b> — Tavily and/or Brave</summary>

An ordinary search engine for factual lookups, news, versions and dates. **Configure this if your MCP client has no web search of its own** — a local LLM, for instance.

- **[Tavily](https://app.tavily.com)** — 1,000 credits/month free, native domain filters, returns full page text, no publication dates
- **[Brave](https://api-dashboard.search.brave.com)** — own independent index, publication dates, no free tier since Feb 2026, rate-limits on lower plans

`KEYWORD_SEARCH_PROVIDER` accepts `auto` | `tavily` | `brave` | `both` and **defaults to `both`**, which queries them in parallel and merges. Each result lists the `engines` that found it, so cross-index agreement is visible to the calling model rather than baked into a ranking here.

**For free-tier-only running, set `KEYWORD_SEARCH_PROVIDER=auto`** — Tavily first, Brave only as a fallback.
</details>

<details>
<summary><b>Semantic web search</b> — Exa</summary>

From [dashboard.exa.ai](https://dashboard.exa.ai). Matches meaning rather than keywords, so *"essays arguing against microservices"* finds pages that never use those words. Also does find-similar-by-URL, which nothing else here can do.

Genuinely complementary to keyword search: semantic is measurably weaker at plain factual lookups, and keyword search can't find a page whose vocabulary you can't guess.
</details>

<details>
<summary><b>X (Twitter)</b> — TwitterAPI.io</summary>

Create an account at [twitterapi.io](https://twitterapi.io/) — instant API key, no X developer approval. Pay-per-use at roughly $0.15/1k tweets. A small free allowance lets you test, throttled to one request per 5 seconds until you add credits.
</details>

<details>
<summary><b>Bot-protected pages</b> — FireCrawl</summary>

From [firecrawl.dev](https://firecrawl.dev). `fetch_page` works without it for open pages — it only escalates when a page is genuinely walled. 1 credit per scrape, up to 5 when the enhanced proxy is needed.
</details>

<details>
<summary><b>Video transcripts</b> — Supadata</summary>

From [supadata.ai](https://supadata.ai), free tier 100/month. Required because the official YouTube API cannot provide transcripts at all: `captions.download` needs the *video owner's* OAuth, and auto-generated captions aren't exposed. Also covers TikTok, Instagram and X video.
</details>

### 3. Local dev (optional)

```bash
npm install
cp .env.example .dev.vars   # then fill in whichever keys you have
npm run dev                 # http://localhost:8787/mcp
npm run typecheck
```

### 4. Deploy

```bash
export CLOUDFLARE_ACCOUNT_ID=<your-account-id>   # npx wrangler whoami

npx wrangler kv namespace create KV
# paste the returned id into wrangler.toml under [[kv_namespaces]]

echo "<value>" | npx wrangler secret put MCP_AUTH_TOKEN   # required
# then one line per provider key you're using:
#   REDDIT_CLIENT_ID  REDDIT_CLIENT_SECRET  YOUTUBE_API_KEY  TAVILY_API_KEY
#   BRAVE_API_KEY  EXA_API_KEY  TWITTERAPI_IO_KEY  FIRECRAWL_API_KEY  SUPADATA_API_KEY

npm run deploy
```

The free Workers plan covers personal use comfortably.

### 5. Register in your MCP client

```bash
claude mcp add --transport http --scope user web-mcp \
  https://web-mcp.<your-subdomain>.workers.dev/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

Claude Code loads MCP servers at startup, so restart afterwards. Any MCP client works the same way: a Streamable HTTP endpoint plus an Authorization header.

## Notes

- **Search technique matters.** Reddit, X and YouTube use keyword matching, not semantic search — a natural-language question silently falls back to merely popular posts. Short keyword queries win, and scoping to a subreddit is the single biggest quality lever. The tool descriptions teach the calling model this, so you don't have to.
- **Transcript costs.** `fetch_page` uses existing captions for 1 credit. Passing `generate: true` transcribes with speech recognition instead, billed **per minute** — a 60-minute talk can cost ~120 credits. Opt-in only, and worth keeping a daily cap on.
- **TwitterAPI.io is third-party** — around 30× cheaper than the official X API, but grey-market access. The provider layer (`src/providers/`) is abstracted, so swapping in the official API is contained.
- **Privacy.** This is a *private, single-user* server: one shared token, no user accounts. Don't publish your worker URL and token together.

## Roadmap

- **Discord** — searching servers you're a member of. Discord has no read API for this, and datacenter IPs are blocked, so the likely shape is a small local companion process rather than a worker provider — separate component, same MCP pattern.
- More sources as the walls go up.

Issues and suggestions welcome.

## License

[MIT](LICENSE)
