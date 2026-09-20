#!/usr/bin/env bash
# web-mcp Discord companion installer (Linux/macOS).
# Installs the companion as a system service, prompts for the relay secret,
# and writes secrets to a file readable only by the service user (Linux) or
# the installing user (macOS). The companion itself is a single
# zero-dependency Node file.
#
# Usage:
#   ./install.sh                     # interactive
#   RELAY_URL=... SECRET=... ./install.sh   # non-interactive (CI/scripts)
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/mike-nott/web-mcp/main"
# System-wide path on Linux (owned by a dedicated service user); user-local on
# macOS where launchd agents run as the installing user and sudo should not
# be required.
if [ "$(uname)" = "Darwin" ]; then
	COMPANION_DIR="$HOME/.local/share/web-mcp-companion"
else
	COMPANION_DIR="/opt/web-mcp-companion"
fi
ENV_FILE="/etc/web-mcp-companion.env"
SERVICE_USER="webmcp"

echo "==> web-mcp Discord companion installer"

RELAY_URL="${RELAY_URL:-https://web-mcp.nott-258.workers.dev/relay}"

# A well-formed worker token: >=20 chars, single line, only the characters
# the token generator can emit. Used for both the interactive prompt and a
# SECRET passed via environment, so neither path can write a bad config.
token_ok() {
	[ -n "$1" ] || return 1
	local trimmed
	trimmed="${1%%[[:space:]]*}"
	[ "${#trimmed}" -ge 20 ] || return 1
	[ "$(printf '%s' "$trimmed" | tr -cd '[:alnum:]_.-=' | wc -c)" -eq "${#trimmed}" ]
}
if [ -z "${SECRET:-}" ]; then
	# Read one line, validate it looks like a token, and re-prompt rather
	# than abort: pasting multi-line clipboard junk must not corrupt the
	# config JSON this value gets written into.
	while :; do
		read -rp "MCP_AUTH_TOKEN (the same token your MCP clients use for this worker): " SECRET
		if token_ok "$SECRET"; then break; fi
		echo "That doesn't look like a token. Paste just the token itself, e.g. webmcp_... — one line, no quotes."
	done
fi
# An env-provided SECRET skips the prompt, so it needs the same check —
# a stale or unrelated ambient variable must not silently produce a
# config the companion rejects (this bit a real install: SECRET was set
# in the shell from earlier testing and never prompted).
token_ok "$SECRET" || { echo "SECRET env var is set but is not a token (webmcp_...). Unset it and rerun: unset SECRET" >&2; exit 1; }

# Normalize the worker URL to wss://<host>/relay, accepting any of:
# https://host, https://host/relay, wss://host, wss://host/relay, bare host.
WORKER_HOST="$(printf '%s' "$RELAY_URL" | sed -E 's|^[a-z]+://||; s|/relay/?$||')"
RELAY_WS_URL="wss://${WORKER_HOST}/relay"

command -v node >/dev/null || { echo "node >= 18 required (https://nodejs.org)"; exit 1; }

# --- files --------------------------------------------------------------
mkdir -p "$COMPANION_DIR"
curl -fsSL "$REPO_RAW/companion/companion.mjs" -o "$COMPANION_DIR/companion.mjs"

if [ "$(uname)" = "Darwin" ]; then
	# launchd: config in the installing user's home, plist in ~/Library/LaunchAgents
	mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
	CONFIG="$HOME/.web-mcp-relay.json"
	umask 077
	# node writes the JSON: correct escaping for any value, and node is
	# already a hard dependency of the companion itself.
	node -e '
		const fs = require("fs");
		fs.writeFileSync(process.argv[1], JSON.stringify({ url: process.argv[2], token: process.argv[3] }));
	' "$CONFIG" "$RELAY_WS_URL" "$SECRET"
	chmod 600 "$CONFIG"
	curl -fsSL "$REPO_RAW/companion/install/com.github.mike-nott.web-mcp-companion.plist" \
		-o "$HOME/Library/LaunchAgents/com.github.mike-nott.web-mcp-companion.plist"
	sed -i '' "s|__HOME__|$HOME|g; s|__NODE__|$(command -v node)|; s|__COMPANION__|$COMPANION_DIR/companion.mjs|" \
		"$HOME/Library/LaunchAgents/com.github.mike-nott.web-mcp-companion.plist"
	launchctl unload "$HOME/Library/LaunchAgents/com.github.mike-nott.web-mcp-companion.plist" 2>/dev/null || true
	launchctl load "$HOME/Library/LaunchAgents/com.github.mike-nott.web-mcp-companion.plist"
	echo "==> installed and loaded (launchd). Logs: tail -f $HOME/Library/Logs/web-mcp-companion.log"
	exit 0
fi

# --- Linux: systemd -----------------------------------------------------
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home /var/lib/webmcp-companion "$SERVICE_USER"
install -d -o "$SERVICE_USER" "$COMPANION_DIR"

umask 077
cat > "$ENV_FILE" <<EOF
RELAY_URL=$RELAY_WS_URL
MCP_AUTH_TOKEN=$SECRET
EOF
chown root:"$SERVICE_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

curl -fsSL "$REPO_RAW/companion/install/web-mcp-companion.service" \
	-o /etc/systemd/system/web-mcp-companion.service
systemctl daemon-reload
systemctl enable --now web-mcp-companion
echo "==> installed and started (systemd). Logs: journalctl -u web-mcp-companion -f"