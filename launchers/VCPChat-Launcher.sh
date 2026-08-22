#!/bin/sh
# Double-click/desktop entry for Linux source distributions.
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TAURI_BIN="$PROJECT_ROOT/apps/bootstrap-installer/src-tauri/target/release/VCPChat-Setup"

if [ -x "$TAURI_BIN" ]; then
  exec env VCPCHAT_PROJECT_ROOT="$PROJECT_ROOT" "$TAURI_BIN" --source-root "$PROJECT_ROOT"
fi

ELECTRON_BIN="$PROJECT_ROOT/node_modules/.bin/electron"

if [ -x "$ELECTRON_BIN" ]; then
  exec "$ELECTRON_BIN" "$PROJECT_ROOT/bootstrap/recovery-main.cjs"
fi

if command -v npm >/dev/null 2>&1 && [ -f "$PROJECT_ROOT/package.json" ]; then
  exec npm --prefix "$PROJECT_ROOT" run vcpchat:ui
fi

if command -v notify-send >/dev/null 2>&1; then
  notify-send "VCPChat 启动器" "请先安装 Node.js 并运行 npm install。"
fi
exit 1
