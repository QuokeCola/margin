#!/bin/bash
# Launch Margin as a desktop app: start the local production server if it
# is not already running, wait for it, then open it in an app window.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/margin"
LOG="$STATE_DIR/server.log"
export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"

cd "$APP_DIR"
mkdir -p "$STATE_DIR"

PORT=$(sed -n 's/^PORT=\([0-9]\+\).*/\1/p' .env 2>/dev/null | tail -1)
PORT=${PORT:-4317}
URL="http://127.0.0.1:$PORT"

fail() {
  omarchy-notification-send -u critical "Margin" "$1" 2>/dev/null || notify-send -u critical "Margin" "$1" 2>/dev/null || true
  echo "$1" >&2
  exit 1
}

up() { curl -fsS --max-time 1 "$URL/api/status" >/dev/null 2>&1; }

if ! up; then
  # Rebuild the bundle when sources are newer than the last build.
  if [[ ! -f dist/index.html ]] || [[ -n $(find src index.html -newer dist/index.html -print -quit) ]]; then
    npm run build >>"$LOG" 2>&1 || fail "Build failed. See $LOG"
  fi
  setsid -f node server.mjs --production >>"$LOG" 2>&1 </dev/null
  for _ in $(seq 1 50); do up && break; sleep 0.2; done
  up || fail "Server did not start on port $PORT. See $LOG"
fi

exec omarchy-launch-webapp "$URL"
