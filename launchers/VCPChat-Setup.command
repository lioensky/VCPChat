#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TAURI_APP="$PROJECT_ROOT/apps/bootstrap-installer/src-tauri/target/release/bundle/macos/VCPChat Setup.app"
TAURI_BIN="$TAURI_APP/Contents/MacOS/VCPChat-Setup"

if [ ! -x "$TAURI_BIN" ]; then
  if command -v osascript >/dev/null 2>&1; then
    osascript -e 'display dialog "尚未构建 VCPChat Setup。请先运行 npm run installer:build。" with title "VCPChat Setup" buttons {"好"} default button "好"'
  fi
  exit 1
fi

exec env VCPCHAT_PROJECT_ROOT="$PROJECT_ROOT" "$TAURI_BIN" --source-root "$PROJECT_ROOT"
