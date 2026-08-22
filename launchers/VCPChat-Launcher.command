#!/bin/sh
# Double-click entry for macOS source distributions.
# This is intentionally separate from npm start and the upstream launchers.
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TAURI_APP="$PROJECT_ROOT/apps/bootstrap-installer/src-tauri/target/release/bundle/macos/VCPChat Setup.app"
TAURI_BIN="$TAURI_APP/Contents/MacOS/VCPChat-Setup"

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

# No runtime is available, so provide an actionable native message instead of
# failing silently. The launcher cannot repair Node/Electron before either is
# present; the packaged installer is the supported path for that case.
if command -v osascript >/dev/null 2>&1; then
  osascript -e 'display dialog "VCPChat 需要先安装 Node.js 并运行 npm install。" with title "VCPChat 启动器" buttons {"好"} default button "好"'
fi
exit 1
