#!/usr/bin/env bash
# web-mcp Discord companion installer (Linux/macOS).
#
# Installs the companion as a system service, prompts for the three values it
# needs, and writes secrets to a file readable only by the service user. The
# companion itself is a single zero-dependency Node file.
#
# Usage:
#   ./install.sh                     # interactive
#   RELAY_URL=... SECRET=... ./install.sh   # non-interactive (CI/scripts)
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/mike-nott/web-mcp/main"
COMPANION_DIR="/opt/web-mcp-companion"
ENV_FILE="/etc/web-mcp-companion.env"
SERVICE_USER="webmcp"

echo "==> web-mcp Discord companion installer"

# --- values -------------------------------------------------------------
RELAY_URL="${RELAY_URL:-https://web-mcp.nott-258.workers.dev/relay}"
if [ -z "${SECRET:-}" ]; then
	read -rp "DISCORD_RELAY_SECRET (from your worker: wrangler secret list): " SECRET
fi
[ -n "$SECRET" ] || { echo "secret required"; exit 1; }

command -v node >/dev/null || { echo "node >= 18 required (https://nodejs.org)"; exit 1; }

# --- files --------------------------------------------------------------
mkdir -p "$COMPANION_DIR"
curl -fsSL "$REPO_RAW/companion/companion.mjs" -o "$COMPANION_DIR/companion.mjs"

if [ "$(uname)" = "Darwin" ]; then
	# launchd: config in the installing user's home, plist in ~/Library/LaunchAgents
	CONFIG="$HOME/.web-mcp-relay.json"
	umask 077
	printf '{"url": "wss://%s/relay", "secret": "%s"}\n' \
		"$(echo "$RELAY_URL" | sed 's|https\?://||; s|/relay$||; s|^wss\?://||')" "$SECRET" \
		> "$CONFIG"
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
RELAY_URL=wss://$(echo "$RELAY_URL" | sed 's|https\?://||; s|/relay$||')/relay
DISCORD_RELAY_SECRET=$SECRET
EOF
chown root:"$SERVICE_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

curl -fsSL "$REPO_RAW/companion/install/web-mcp-companion.service" \
	-o /etc/systemd/system/web-mcp-companion.service
systemctl daemon-reload
systemctl enable --now web-mcp-companion
echo "==> installed and started (systemd). Logs: journalctl -u web-mcp-companion -f"