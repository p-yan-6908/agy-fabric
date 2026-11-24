#!/usr/bin/env bash
set -euo pipefail

PLUGIN_DIR="${AGY_FABRIC_PLUGIN_DIR:-$HOME/.gemini/config/plugins/fabric}"
BIN_DIR="${AGY_FABRIC_BIN_DIR:-$HOME/.local/bin}"

is_fabric_launcher() {
  local f="$1"
  [ -f "$f" ] || return 1
  local magic=""
  LC_ALL=C IFS= read -r -n 2 magic < "$f" 2>/dev/null || true
  [ "$magic" = "#!" ] || return 1
  LC_ALL=C head -n 5 "$f" 2>/dev/null | grep -q 'agy-fabric-launcher'
}

echo "==> Removing Fabric plugin and CLI launchers"
rm -rf "$PLUGIN_DIR"
rm -f "$BIN_DIR/agyf" "$BIN_DIR/agy-compact"

REMOVED_LAUNCHER=0
RESTORED_ORIG=0
if is_fabric_launcher "$BIN_DIR/agy"; then
  rm -f "$BIN_DIR/agy"
  REMOVED_LAUNCHER=1
fi

if [ -e "$BIN_DIR/.agy-orig/agy" ] || [ -L "$BIN_DIR/.agy-orig/agy" ]; then
  if [ ! -e "$BIN_DIR/agy" ] && [ ! -L "$BIN_DIR/agy" ]; then
    mv "$BIN_DIR/.agy-orig/agy" "$BIN_DIR/agy"
    RESTORED_ORIG=1
  else
    rm -f "$BIN_DIR/.agy-orig/agy"
  fi
  rmdir "$BIN_DIR/.agy-orig" 2>/dev/null || true
fi

echo "Removed:"
echo "  - $PLUGIN_DIR"
[ "$REMOVED_LAUNCHER" -eq 1 ] && echo "  - $BIN_DIR/agy (Fabric launcher)"
echo "  - $BIN_DIR/agy-compact"
if [ "$RESTORED_ORIG" -eq 1 ]; then
  echo "Restored:"
  echo "  - $BIN_DIR/agy (stock Antigravity CLI binary)"
fi
echo ""
echo "Note: ~/.gemini/antigravity-cli/statusline.sh and settings.json were left untouched."
