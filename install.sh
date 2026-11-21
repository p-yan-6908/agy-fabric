#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="${AGY_FABRIC_PLUGIN_DIR:-$HOME/.gemini/config/plugins/fabric}"
BIN_DIR="${AGY_FABRIC_BIN_DIR:-$HOME/.local/bin}"
STATUSLINE_PATH="$HOME/.gemini/antigravity-cli/statusline.sh"
SETTINGS_PATH="$HOME/.gemini/antigravity-cli/settings.json"
WITH_STATUSLINE=0
SKIP_DEPS=0

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Install the Fabric Code Mode plugin for Antigravity (agy), plus the `agyf` and
`agy-compact` CLI launchers.

Options:
  --with-statusline     Also install scripts/statusline.sh (feeds live token/context
                        telemetry to compact.pressure()) and print settings.json config
  --plugin-dir <dir>    Target plugin directory (default: ~/.gemini/config/plugins/fabric)
  --bin-dir <dir>       Target bin directory for agyf/agy-compact (default: ~/.local/bin)
  --skip-deps           Skip running `bun install` (if node_modules is already installed)
  -h, --help            Show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --with-statusline)
      WITH_STATUSLINE=1
      shift
      ;;
    --plugin-dir)
      PLUGIN_DIR="$2"
      shift 2
      ;;
    --bin-dir)
      BIN_DIR="$2"
      shift 2
      ;;
    --skip-deps)
      SKIP_DEPS=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

find_bun() {
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi
  for candidate in "$HOME/.bun/bin/bun" "/opt/homebrew/bin/bun" "/usr/local/bin/bun"; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

BUN_BIN="$(find_bun)" || {
  echo "Error: bun is required. Install it from https://bun.sh (e.g. curl -fsSL https://bun.sh/install | bash)." >&2
  exit 1
}

if ! command -v agy >/dev/null 2>&1; then
  echo "Warning: 'agy' (Antigravity CLI) not found in PATH yet. Continuing installation..." >&2
fi

if ! command -v rg >/dev/null 2>&1; then
  echo "Note: 'rg' (ripgrep) not found; installing ripgrep is recommended for fast pi.grep/pi.find." >&2
fi

echo "==> Installing plugin to $PLUGIN_DIR"
mkdir -p "$PLUGIN_DIR/agents" "$PLUGIN_DIR/assets" "$PLUGIN_DIR/server"

cp "$SCRIPT_DIR/plugin.json" "$PLUGIN_DIR/plugin.json"
cp "$SCRIPT_DIR/package.json" "$PLUGIN_DIR/package.json"
cp "$SCRIPT_DIR/README.md" "$PLUGIN_DIR/README.md"
cp "$SCRIPT_DIR/agents/fabric.md" "$PLUGIN_DIR/agents/fabric.md"
cp "$SCRIPT_DIR/assets/logo.svg" "$PLUGIN_DIR/assets/logo.svg"
cp "$SCRIPT_DIR/server/"*.mjs "$PLUGIN_DIR/server/"
chmod +x "$PLUGIN_DIR/server/mcp-server.mjs" "$PLUGIN_DIR/server/hook-cwd.mjs" "$PLUGIN_DIR/server/tui-proxy.mjs"

# Write resolved absolute bun + plugin paths so Antigravity launches hooks and MCP
# reliably even when ~/.bun/bin is not in the GUI/non-login PATH.
cat > "$PLUGIN_DIR/mcp_config.json" <<EOF
{
  "mcpServers": {
    "fabric": {
      "command": "$BUN_BIN",
      "args": [
        "$PLUGIN_DIR/server/mcp-server.mjs"
      ]
    }
  }
}
EOF

cat > "$PLUGIN_DIR/hooks.json" <<EOF
{
  "fabric-lifecycle": {
    "SessionStart": [
      {
        "type": "command",
        "command": "$BUN_BIN $PLUGIN_DIR/server/hook-cwd.mjs",
        "timeout": 10
      }
    ],
    "PreInvocation": [
      {
        "type": "command",
        "command": "$BUN_BIN $PLUGIN_DIR/server/hook-cwd.mjs",
        "timeout": 15
      }
    ],
    "PreToolUse": [
      {
        "matcher": ".*fabric.*|mcp.*",
        "hooks": [
          {
            "type": "command",
            "command": "$BUN_BIN $PLUGIN_DIR/server/hook-cwd.mjs",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "type": "command",
        "command": "$BUN_BIN $PLUGIN_DIR/server/hook-cwd.mjs",
        "timeout": 10
      }
    ]
  }
}
EOF

if [ "$SKIP_DEPS" -eq 0 ]; then
  echo "==> Installing npm dependencies (pi-fabric, pi-fovea, pi-context-engineer)"
  (cd "$PLUGIN_DIR" && "$BUN_BIN" install --production)
fi

echo "==> Installing CLI launchers to $BIN_DIR"
mkdir -p "$BIN_DIR"
cp "$SCRIPT_DIR/bin/agyf" "$BIN_DIR/agyf"
cp "$SCRIPT_DIR/bin/agy-compact" "$BIN_DIR/agy-compact"
chmod +x "$BIN_DIR/agyf" "$BIN_DIR/agy-compact"

if [ "$WITH_STATUSLINE" -eq 1 ]; then
  echo "==> Installing statusline.sh to $STATUSLINE_PATH"
  mkdir -p "$(dirname "$STATUSLINE_PATH")"
  cp "$SCRIPT_DIR/scripts/statusline.sh" "$STATUSLINE_PATH"
  chmod +x "$STATUSLINE_PATH"
  if ! command -v jq >/dev/null 2>&1; then
    echo "Warning: statusline.sh requires 'jq'. Install jq (e.g. brew install jq / apt install jq)." >&2
  fi
  echo "    Enable it in $SETTINGS_PATH by adding:"
  cat <<'EOF'
    "statusLine": {
      "type": "command",
      "command": "~/.gemini/antigravity-cli/statusline.sh",
      "enabled": true
    }
EOF
fi

if command -v agy >/dev/null 2>&1; then
  echo "==> Validating plugin with agy"
  agy plugin validate "$PLUGIN_DIR" --strict || true
fi

echo ""
echo "Done! Launch Fabric Code Mode with:"
echo "  agyf"
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo ""
  echo "Note: $BIN_DIR is not currently in your PATH. Add this to your shell profile:"
  echo "  export PATH="$BIN_DIR:$PATH""
fi
