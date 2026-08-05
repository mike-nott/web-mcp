# Architecture

Notes for anyone extending Web-MCP — including future you. The [README](README.md) covers what it does and how to deploy it; this covers *why it is shaped this way*, how to add a provider, and the non-obvious facts about each upstream API that cost real time to discover.

## Design principles

**No LLM in the worker.** The server fetches and normalises; the calling model does all reasoning. A second model in the pipe would add cost and latency to sand the nuance off results the caller is better placed to judge. This is why `include_answer` (Tavily) and Exa's answer modes are deliberately unused.

**Thin pipe — no ranking or synthesis.** Where results from several sources are merged, each source's own ordering is preserved and interleaved; nothing is re-scored. Provenance is reported (`engines` on keyword results, `platform` on social results, `tier` on fetched pages) so the caller can weigh it. Cross-index agreement is a *fact we hand over*, not a rank we invent.

**The tool surface follows configuration.** `tools/list` is built from detected capabilities, so a client is never offered a tool whose provider is unconfigured — and never has to discover that by failing. Descriptions are assembled the same way: `fetch_page` only claims to defeat bot protection when FireCrawl is present.

**Free tier first, paid only on failure.** `fetch_page` tries a direct fetch and escalates to FireCrawl only when the page is genuinely blocked. Every paid provider also has a daily ceiling that returns a readable message rather than a surprise bill.

**Failures are explicit, never disguised as content.** A blocked page returns an error, never the challenge page's own HTML — that failure mode is what leads agents to confidently summarise a Cloudflare interstitial. Runtime failures come back as `isError` tool results (readable by the model) rather than JSON-RPC protocol errors; only schema violations are protocol errors.

**Tool descriptions are the routing signal.** They are the only thing an MCP client sees when choosing, so they carry usage guidance, worked BAD/GOOD examples, and explicit cross-routing between tools. Descriptions explain *why*, not just *what* — reasons survive a model's paraphrasing better than bare rules.

## Adding a provider

`src/providers/tavily.ts` is the cleanest example to copy: ~110 lines, no auth dance, native parameters.

**1. Write `src/providers/<name>.ts`** following the house shape:

```ts
const API_URL = '...';           // endpoints and limits as named consts
const MAX_RESULTS = 20;          // with a comment saying why the number

export async function nameSearch(env: Env, args: KeywordArgs): Promise<KeywordResponse> {
  if (!env.NAME_API_KEY) throw new ProviderError('NAME_API_KEY is not configured.');
  await consumeBudget(env, 'name');          // before the network call
  const res = await fetch(...);
  if (!res.ok) { /* map 401/402/429 to specific ProviderError messages */ }
  return { results: raw.map(toSharedType), notes, engines: ['name'] };
}
```

Map into an existing shape from `src/providers/types.ts` rather than inventing one — `SearchResult`, `Thread`, `WebResult`, `KeywordArgs`/`KeywordResponse`, `ScrapedPage`. Throw `ProviderError` with a message a *user* can act on; `src/tools.ts` turns it into an `isError` result.

**2. Wire four places:**

| File | Add |
|---|---|
| `src/env.ts` | `NAME_API_KEY` and any `NAME_DAILY_LIMIT` |
| `src/capabilities.ts` | a `name: boolean` on `Capabilities`, set in `detectCapabilities` |
| `src/budget.ts` | an entry in `SETTINGS` — label, default limit, env var, and advice naming what still works when exhausted |
| `wrangler.toml` | the daily-limit var, plus the key in the secrets comment |

**3. Gate it in `src/mcp/handlers.ts`** so the tool (or the enum value) only appears when the capability is present, and update the description conditionally.

**4. Update** the README capability matrix and `.env.example`.

Budgets accept `0` to disable a cap. Cache TTLs live in `src/cache.ts`: searches and pages 1h, threads 15min, communities 24h.

## Provider gotchas

Facts that are not guessable from vendor documentation — two of them actively contradict it.

| Provider | Gotcha | Consequence in code |
|---|---|---|
| **Reddit** | Tokens last **24h** (`expires_in: 86400`), not 1h | An earlier hardcoded 55-min TTL re-authenticated ~26×/day and triggered rate limiting. Lifetime is now read from the response |
| **Reddit** | Datacenter IPs **must** use OAuth and a descriptive User-Agent | Anonymous fetches 403; the UA is configurable in `wrangler.toml` |
| **Reddit** | Search is lexical, and a sentence-shaped query silently falls back to *popular* results | Descriptions teach keyword queries with BAD/GOOD pairs |
| **Tavily** | Docs describe `usage.credits`; the live API returns **no `usage` object at all** | Read defensively, never relied upon. No publication dates either |
| **Brave** | `count` caps at 20; low plans rate-limit at ~1 QPS | Limit clamps with a note; two retries with backoff |
| **Brave** | No native domain filters | `include_domains`/`exclude_domains` translate to `site:` operators |
| **YouTube** | `search.list` costs ~100× `videos.list`/`commentThreads.list`, in its own ~100/day bucket | Only *search* is budgeted; metadata and comments are effectively free |
| **YouTube** | `search.list` returns **no statistics** | Every search is followed by one batched `videos.list` (50 ids, 1 unit) |
| **YouTube** | The API **cannot** return transcripts — `captions.download` needs the video owner's OAuth | Transcripts require a third-party provider; scraping the watch page from a datacenter IP returns chrome and a 401 |
| **Supadata** | `mode=auto` silently falls back to AI generation billed **per minute** (a 60-min talk ≈ 120 credits) | Pinned to `native`; `generate: true` is an explicit opt-in |
| **Supadata** | Videos >20 min return `202` + a job id | Polled within budget; the job id is cached so a retry resumes rather than paying twice |
| **FireCrawl** | A 403 challenge page can come back as `success: true` with junk markdown | Status code *and* content length are validated, not just `success` |
| **Exa** | `deep`/`deep-reasoning` modes can run for minutes | Pinned to `auto` — anything longer breaks client tool timeouts |
| **Cloudflare** | KV is eventually consistent, and deploys propagate unevenly for a minute or two | Don't judge a deploy immediately; verify by polling until behaviour is consistent |
| **HTMLRewriter** | `element.remove()` strips from *output*, but text handlers still fire for removed content | Transform first, then strip tags — collecting via handlers leaks script bodies |

## MCP client compatibility

| Client | Status |
|---|---|
| Claude Code | ✅ |
| OpenCode | ✅ discovers and calls tools |
| Codex | ✅ discovers all tools (its non-interactive `exec` mode auto-cancels calls needing approval; it also prefers its own built-in `web_search`) |
| Jan | ❌ connects cleanly and reads capabilities, but surfaces no tools — no errors in its logs; appears to be a client-side bug |

Two server-side properties turned out to decide whether a client works at all, both learned the hard way:

**Session management must be optional.** The server issues no `Mcp-Session-Id` and requires none. When it *did* require one, any client that failed to echo the header got `-32600` inside an HTTP `200` — so it displayed zero tools with no error to explain why. The MCP spec makes sessions optional precisely so stateless servers can exist.

**SSE is not optional in practice.** Clients advertise `Accept: text/event-stream` first and open a `GET /mcp` stream. Returning JSON everywhere and `405` on `GET` is spec-legal but caused at least one client to reconnect in a loop. `POST` now answers with an SSE frame when asked, `GET` returns a keepalive stream, and heartbeats every 15s keep long calls (transcripts, bot-protection escalation) inside client idle timeouts.

## Layout

```
src/
  index.ts            fetch handler, JSON-RPC dispatch, SSE, CORS
  auth.ts             single-secret bearer auth
  capabilities.ts     which providers are configured
  budget.ts           per-provider daily ceilings
  cache.ts            KV response cache
  tools.ts            tool execution; ProviderError → isError result
  mcp/                protocol layer — types, errors, tool schemas & descriptions
  providers/          one file per upstream API, plus shared types.ts
```

The JSON-RPC transport is hand-rolled: the official MCP SDK has Node-only dependencies and does not run on Workers.
