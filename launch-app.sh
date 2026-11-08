#!/bin/bash
# Launch Margin as a desktop app (Electron) from this project folder.
# The desktop app is needed for "Add to project" through a publisher sign-in window.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/margin"
LOG="$STATE_DIR/desktop.log"
export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"
cd "$APP_DIR"
mkdir -p "$STATE_DIR"

fail() {
  omarchy-notification-send -u critical "Margin" "$1" 2>/dev/null || notify-send -u critical "Margin" "$1" 2>/dev/null || true
  echo "$1" >&2
  exit 1
}

# Rebuild the interface when sources are newer than the last build.
if [[ ! -f dist/index.html ]] || [[ -n $(find src index.html -newer dist/index.html -print -quit) ]]; then
  npm run build >>"$LOG" 2>&1 || fail "Build failed. See $LOG"
fi
[[ -x node_modules/.bin/electron ]] || fail "Electron is not installed. Run 'npm ci' in $APP_DIR."

# Keep using the API key saved by the browser version (the project's .env) and the same library.
export MARGIN_ENV_FILE="$APP_DIR/.env"
exec node_modules/.bin/electron "$APP_DIR" >>"$LOG" 2>&1
