#!/usr/bin/env bash
set -euo pipefail

PLUGIN_DIR="${AGY_FABRIC_PLUGIN_DIR:-$HOME/.gemini/config/plugins/fabric}"
BIN_DIR="${AGY_FABRIC_BIN_DIR:-$HOME/.local/bin}"

echo "==> Removing Fabric plugin and CLI launchers"
rm -rf "$PLUGIN_DIR"
rm -f "$BIN_DIR/agyf" "$BIN_DIR/agy-compact"

echo "Removed:"
echo "  - $PLUGIN_DIR"
echo "  - $BIN_DIR/agyf"
echo "  - $BIN_DIR/agy-compact"
echo ""
echo "Note: ~/.gemini/antigravity-cli/statusline.sh and settings.json were left untouched."
