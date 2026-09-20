#!/usr/bin/env bash
# web-mcp first-time setup.
#
# Deploys the worker (fresh KV namespace, generated MCP_AUTH_TOKEN), optionally
# sets the Discord token, and offers to install the Discord companion on THIS
# machine — passing the just-generated token along so it is never typed twice.
#
# Safe to re-run: an already-deployed worker keeps its existing token unless
# you explicitly ask to rotate it.
#
# Run from the repo root:  ./setup.sh
set -euo pipefail
cd "$(dirname "$0")"
tty_read() { read -rp "$1" "$2" </dev/tty; }
say() { printf '==> %s\n' "$*"; }

# --- prerequisites ---------------------------------------------------------
command -v node >/dev/null || { echo "node >= 18 required (https://nodejs.org)"; exit 1; }
npx wrangler whoami >/dev/null 2>&1 \
	|| { echo "Not logged in to Cloudflare. Run: npx wrangler login"; exit 1; }
say "prerequisites ok"

# --- KV namespace ----------------------------------------------------------
# A fresh clone still has the repo author's KV id; every deployment needs its
# own namespace or it would share cache/budget state with strangers.
create_kv() {
	local out id
	out="$(npx wrangler kv namespace create KV 2>&1)" || true
	id="$(printf '%s' "$out" | grep -oE '"id": *"[a-f0-9]+"' | head -1 | grep -oE '[a-f0-9]{20,}')"
	[ -n "$id" ] || id="$(printf '%s' "$out" | grep -oE 'id = "[a-f0-9]+"' | head -1 | grep -oE '[a-f0-9]{20,}')"
	# Title collision: "A KV namespace with the title "KV" already exists."
	# The account already has one (this script, or an earlier manual deploy) —
	# offer reuse before failing; a fresh namespace is rarely what the user
	# actually needs on a re-run.
	if [ -z "$id" ] && printf '%s' "$out" | grep -q 'already exists'; then
		existing="$(npx wrangler kv namespace list 2>/dev/null \
			| python3 -c 'import json,sys; print(next((n["id"] for n in json.load(sys.stdin) if n["title"]=="KV"), ""))' 2>/dev/null)"
		if [ -n "$existing" ]; then
			tty_read "A KV namespace titled \"KV\" already exists ($existing). Reuse it? [Y/n] " ans
			if [ "${ans:-y}" != "n" ]; then
				id="$existing"
			else
				# Fresh namespace under a unique title; wire it in as usual.
				local title="web-mcp-kv-$(date +%s)"
				out="$(npx wrangler kv namespace create "$title" 2>&1)" || { echo "$out" | tail -5; exit 1; }
				id="$(printf '%s' "$out" | grep -oE '[a-f0-9]{20,}' | head -1)"
				[ -n "$id" ] || { echo "Could not parse the new namespace id from:"; echo "$out" | tail -5; exit 1; }
			fi
		fi
	fi
	[ -n "$id" ] || { echo "Could not create or find a KV namespace:"; echo "$out" | tail -5; exit 1; }
	sed -i.bak -E "s|^(id = \")[a-f0-9]+(\")|\\1${id}\\2|" wrangler.toml && rm wrangler.toml.bak
	say "KV namespace wired into wrangler.toml ($id)"
}

CURRENT_KV_ID="$(sed -nE 's/^id = "([a-f0-9]+)"/\1/p' wrangler.toml | head -1)"
if [ -n "${KV_ID:-}" ]; then
	say "using KV id from env (\$KV_ID)"
elif printf '%s' "$CURRENT_KV_ID" | grep -q '^f420d454b34a4bffbdde610ff23f71d5$'; then
	# Fresh clone: wrangler.toml still carries the repo author's namespace.
	create_kv
else
	tty_read "KV namespace already configured ($CURRENT_KV_ID). Create a fresh one instead? [y/N] " ans
	[ "${ans:-n}" = "y" ] && create_kv
fi

# --- deploy first (secrets need an existing worker) -------------------------
say "deploying worker (secrets are set right after)"
DEPLOY_OUT="$(npm run deploy 2>&1)" || { echo "$DEPLOY_OUT" | tail -20; exit 1; }
printf '%s\n' "$DEPLOY_OUT" | tail -5
WORKER_URL="$(printf '%s' "$DEPLOY_OUT" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)"
[ -n "$WORKER_URL" ] || WORKER_URL="https://$(sed -nE 's/^name = "(.+)"$/\1/p' wrangler.toml | head -1).$(npx wrangler whoami 2>/dev/null | grep -oE '[a-z0-9-]+\.workers\.dev' | head -1)"
say "worker deployed: $WORKER_URL"

# --- MCP_AUTH_TOKEN ---------------------------------------------------------
TOKEN=""
if npx wrangler secret list 2>/dev/null | grep -q MCP_AUTH_TOKEN; then
	say "worker already has an MCP_AUTH_TOKEN (existing clients keep working)"
	tty_read "Rotate it? New token = reconfigure every client. [y/N] " ans
	if [ "${ans:-n}" = "y" ]; then
		TOKEN="webmcp_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
		printf '%s' "$TOKEN" | npx wrangler secret put MCP_AUTH_TOKEN
		say "NEW token (update your clients): $TOKEN"
	fi
else
	TOKEN="webmcp_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
	printf '%s' "$TOKEN" | npx wrangler secret put MCP_AUTH_TOKEN
	say "generated MCP_AUTH_TOKEN — save it, your MCP clients need it:"
	echo "    $TOKEN"
fi

# --- Discord (optional) -------------------------------------------------------
DISCORD_ADDED=0
if npx wrangler secret list 2>/dev/null | grep -q DISCORD_USER_TOKEN; then
	say "Discord already configured (DISCORD_USER_TOKEN present)"
	DISCORD_ADDED=1
else
	tty_read "Add Discord search now? Needs a token from a DEDICATED account (see README). [y/N] " ans
	if [ "${ans:-n}" = "y" ]; then
		while :; do
			tty_read "DISCORD_USER_TOKEN: " dtoken
			# Discord user tokens: base64-ish, 60-80 chars, no spaces.
			if [ "$(printf '%s' "$dtoken" | tr -cd 'A-Za-z0-9._-=' | wc -c)" -eq "${#dtoken}" ] \
				&& [ "${#dtoken}" -ge 50 ]; then
				break
			fi
			echo "That doesn't look like a Discord token. One line, no spaces (see README for extraction)."
		done
		printf '%s' "$dtoken" | npx wrangler secret put DISCORD_USER_TOKEN
		say "Discord token stored"
		DISCORD_ADDED=1
	fi
fi

# --- companion offer -----------------------------------------------------------
if [ "$DISCORD_ADDED" = 1 ]; then
	tty_read "Install the Discord companion on THIS machine now? [Y/n] " ans
	if [ "${ans:-y}" != "n" ]; then
		# The token generated/kept above is passed directly — the companion
		# authenticates with the same MCP_AUTH_TOKEN, so it never re-prompts.
		if [ -n "$TOKEN" ]; then
			SECRET="$TOKEN" RELAY_URL="$WORKER_URL/relay" bash companion/install/install.sh
		else
			RELAY_URL="$WORKER_URL/relay" bash companion/install/install.sh
		fi
	fi
fi

say "done. Point your MCP clients at: $WORKER_URL/mcp (Authorization: Bearer <token>)"
[ "$DISCORD_ADDED" = 0 ] && say "Discord can be added later: see README 'Discord companion'" || true