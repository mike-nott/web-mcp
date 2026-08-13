# Discord — research and design decision

Research from 2026-08-04, kept because the *rejected* options matter as much as the chosen one. Discord is the last item on the roadmap and the only source that cannot be reached the way everything else in this project is.

## Why Discord is different

Every other source here has some sanctioned programmatic route — an official API (Reddit, YouTube), a paid third party (X, transcripts), or plain HTTP (open web). Discord has none:

- **No search API.** Nothing in the official API searches messages across servers.
- **No public content.** Nothing is readable without being a member; there is no anonymous view to fetch.
- **Bots must be invited per server** by someone holding *Manage Server*. There is no public flag marking a server as bot-friendly — it is entirely an admin's decision, and "let my personal read-bot index your channels" is a privacy ask most community moderators refuse.
- **Bots need the Message Content intent**, which means the bot genuinely reads messages — precisely what makes moderators wary.

So the official path only ever covers servers you own or can persuade an admin about, which excludes the large AI/dev communities where the useful discussion actually is.

## Options considered

| Option | Verdict |
|---|---|
| Official bot in the Cloudflare worker | ❌ Needs a per-server invite; the valuable servers won't grant one |
| Burner account + self-bot from the worker | ❌ ToS-banned; datacenter IP is the giveaway |
| Real account token from the worker | ❌ Same detection, but risks the primary account |
| Browser automation driven by the assistant | ❌ Rejected — Mike dislikes that workflow |
| **Local Playwright on Mike's Mac** | ✅ **Chosen** |

### Why not a self-bot, even a low-volume one

Automating *any* user account is explicitly against Discord's terms, second account or not. The practical risk profile does change with usage, though, and that distinction is worth recording honestly:

| Risk driver | Continuous reader | On-demand search only |
|---|---|---|
| Request volume | High, constant | A few calls, sporadic |
| Behavioural pattern | Obviously robotic | Resembles a person searching |
| Practical ban risk | High | Low — most self-bot bans target scale and spam |

Discord's client does expose a per-server search endpoint (`/guilds/{id}/messages/search`) that a user token can call directly, so a search-only self-bot is a handful of REST calls, not a crawl. Two fingerprints undermine it regardless of volume:

1. **No gateway presence.** REST calls from a token that never opens the websocket — so the account never appears online — is a known self-bot tell.
2. **Source IP.** Calls from Cloudflare datacenter ranges look nothing like a person at home. For a worker-hosted design this is the bigger tell.

Using the **real** account rather than a burner is worse on a dimension beyond bans: a token used from a datacenter IP while the genuine client is active from home is the classic account-compromise signature, and can trigger forced logouts and password resets. Tokens also rotate on every password change or logout-all, so the integration breaks silently. The one thing the real token buys — existing server memberships — isn't worth putting the primary account behind the riskiest component.

## Chosen design: local Playwright

A small local process on Mike's Mac driving his real, logged-in Discord session.

```
Claude Code / OpenCode ──stdio or localhost──▶ local process ──▶ Chromium (real session) ──▶ Discord
```

Every fingerprint that made the other options risky disappears:

| Tell | Worker + user token | Local Chromium |
|---|---|---|
| IP | Datacenter ASN 🚩 | Residential ✅ |
| Client fingerprint | Forged REST calls 🚩 | Genuine Chrome + real profile ✅ |
| Gateway presence | Absent 🚩 | Real websocket; account appears online ✅ |
| Token handling | Extracted, rotates, breaks | Normal session cookies ✅ |

Discord's own search UI is also good — `from:`, `in:`, `has:` and date filters — so this drives the real search box rather than reverse-engineering an internal endpoint.

**Why IP reputation dominates:** residential and mobile addresses sit behind CGNAT, where hundreds of real subscribers share one IP, so blocking it would block paying customers and anti-bot systems are correspondingly cautious. Datacenter IPs belong to known hosting ASNs and are blocked aggressively. This is the same mechanism that explains other datacenter-IP failures seen in this project — YouTube watch pages returning a 401 to the worker, and geolocation-skewed results from Zillow.

### Architectural consequence

Discord does **not** belong in the Cloudflare worker. Two components, split by access model:

```
Reddit · X · YouTube · web  → CF Worker (API keys)      → MCP over HTTPS
Discord                     → local process on the Mac  → MCP over stdio/localhost
```

Two MCP servers is *simpler* than tunnelling from the worker back to the Mac — no ingress, no extra auth, no dependency on the Mac being reachable from the internet.

## Honest trade-offs

- Only works while the Mac is awake and the session is logged in.
- Slower than an API — seconds per search, not milliseconds.
- Still automation of a user session. Lower risk than the alternatives, not zero: fine for occasional research, not for volume.
- Coverage is limited to servers Mike is already a member of.

## Open questions before building

1. **Scope** — search across all servers, or a named few? Search results only, or full message threads? This decides whether we drive the global search UI or something narrower.
2. **Connection** — a separate local stdio MCP server is the assumed shape; confirm before building.
3. **Tooling** — Playwright over Puppeteer, for better persistent-context handling and a stronger stealth ecosystem.
