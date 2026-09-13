#!/usr/bin/env bash
#
# Restart dsh-desktop.
#
#   ./dev.sh                        restart, pointed at the URL used last time
#   ./dev.sh '<tokenised url>'      restart, pointed at that URL (and remember it)
#   DSH_URL='...' ./dev.sh          the same thing by environment
#
# The DSH this shows is NOT started here and never will be. Run `dsh web --port 3090` in your
# own terminal, copy the tokenised URL it prints, and hand it to this script once; it is kept in
# .dev-url so later restarts need no argument.
#
# Only this app is stopped. Your `dsh web` is a different process and is deliberately left
# running, so restarting the window never costs you the session inside it.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL_FILE="$ROOT/.dev-url"
LOG="${DSH_DESKTOP_LOG:-/tmp/dsh-desktop.log}"
BROWSER_START="${DSH_BROWSER_START:-https://example.com/}"

case "${1:-}" in
  -h|--help)
    sed -n '3,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

if [ "$#" -ge 1 ] && [ -n "$1" ]; then
  printf '%s' "$1" > "$URL_FILE"
elif [ -n "${DSH_URL:-}" ]; then
  printf '%s' "$DSH_URL" > "$URL_FILE"
elif [ ! -f "$URL_FILE" ]; then
  echo "No URL yet." >&2
  echo "Run 'dsh web --port 3090' in your terminal and pass the URL it prints:" >&2
  echo "  ./dev.sh 'http://127.0.0.1:3090/?token=...'" >&2
  exit 1
fi
URL="$(cat "$URL_FILE")"

# Matched against this app's own path rather than the word "electron", so no other Electron
# application on the machine is caught by a restart.
pkill -f 'desktop/node_modules/electron' 2>/dev/null || true
sleep 1

cd "$ROOT/desktop"
: > "$LOG"
DSH_URL="$URL" DSH_BROWSER_START="$BROWSER_START" nohup ./node_modules/.bin/electron . >> "$LOG" 2>&1 &
disown

# The bridge prints this once it is listening, which is the moment the agent's browser tools can
# reach the app. Waiting for it means a restart that returns has actually restarted something.
for _ in $(seq 1 60); do
  sleep 0.5
  if grep -q 'annotation bridge listening' "$LOG" 2>/dev/null; then
    printf 'dsh-desktop is up\n  left pane:  %s\n  log:        %s\n' "$URL" "$LOG"
    exit 0
  fi
done

echo "dsh-desktop did not come up within 30s. Last lines of $LOG:" >&2
tail -n 8 "$LOG" >&2
exit 1
