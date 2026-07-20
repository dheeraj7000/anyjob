#!/usr/bin/env bash
# Starts everything needed to test the anyjob browser extension:
#   - the local anyjob server (src/server.ts)
#   - the anyapi DeepSeek daemon, but only if .env has LLM_TRANSPORT=anyapi-daemon
#   - syncs shared-browser/formUtils.js into extension/shared/
# Safe to re-run: skips anything already running instead of erroring.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/root/miniconda3/bin:$PATH"
export PYTHONUNBUFFERED=1

mkdir -p data
SERVER_LOG="data/server.log"
DAEMON_LOG="data/deepseek-daemon.log"
SERVER_PID_FILE="data/server.pid"
DAEMON_PID_FILE="data/deepseek-daemon.pid"
PORT="${ANYJOB_SERVER_PORT:-4173}"

is_pid_alive() {
  [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null
}

echo "==> Syncing extension form-utils.js"
npm run --silent sync-extension

echo "==> anyjob server"
if is_pid_alive "$SERVER_PID_FILE"; then
  echo "    already running (pid $(cat "$SERVER_PID_FILE"))"
elif curl -s -o /dev/null "http://127.0.0.1:${PORT}/api/health"; then
  echo "    something is already listening on 127.0.0.1:${PORT} (not started by this script) -- leaving it alone"
else
  # exec straight into tsx (not "npm run serve") so the PID we record is the
  # real server process -- npm's own process doesn't reliably forward
  # signals to its child, which would make stop.sh's kill silently no-op.
  (exec nohup node_modules/.bin/tsx src/server.ts > "$SERVER_LOG" 2>&1) &
  echo $! > "$SERVER_PID_FILE"
  echo "    starting (pid $!), logging to $SERVER_LOG"
  for _ in $(seq 1 30); do
    curl -s -o /dev/null "http://127.0.0.1:${PORT}/api/health" && break
    sleep 1
  done
fi

TOKEN=""
if [ -f data/extension-token.txt ]; then
  TOKEN=$(cat data/extension-token.txt)
fi

echo "==> anyapi DeepSeek daemon"
if ! grep -q "^LLM_TRANSPORT=anyapi-daemon" .env 2>/dev/null; then
  echo "    skipped -- .env is not set to LLM_TRANSPORT=anyapi-daemon"
elif is_pid_alive "$DAEMON_PID_FILE"; then
  echo "    already running (pid $(cat "$DAEMON_PID_FILE"))"
elif [ -S "$HOME/.local/share/anyapi/deepseek_daemon.sock" ] && pgrep -f "anyapi-daemon.*deepseek" > /dev/null; then
  echo "    already running (not started by this script) -- leaving it alone"
else
  COOKIES="${DEEPSEEK_COOKIES_PATH:-/root/myai/deepseek_cookies.json}"
  LOCALSTORAGE="${DEEPSEEK_LOCALSTORAGE_PATH:-/root/myai/deepseek_localstorage.json}"
  chmod 600 "$COOKIES" "$LOCALSTORAGE" 2>/dev/null || true
  DAEMON_LOG_ABS="$(pwd)/$DAEMON_LOG"
  # exec (twice: subshell -> nohup -> anyapi-daemon) so the backgrounded PID
  # we save is the real daemon process, not a wrapper shell one layer up --
  # otherwise stop.sh's kill targets the wrong process.
  (cd /root/myai && exec nohup python3 -u /root/miniconda3/bin/anyapi-daemon --provider deepseek --verbose --cookies "$COOKIES" --localstorage "$LOCALSTORAGE" > "$DAEMON_LOG_ABS" 2>&1) &
  echo $! > "$DAEMON_PID_FILE"
  echo "    starting (pid $(cat "$DAEMON_PID_FILE")), logging to $DAEMON_LOG -- this launches Chromium, can take ~30s"
  for _ in $(seq 1 60); do
    grep -q "Starting IPC server" "$DAEMON_LOG" 2>/dev/null && break
    grep -qi "error" "$DAEMON_LOG" 2>/dev/null && { echo "    ERROR -- see $DAEMON_LOG"; break; }
    sleep 1
  done
fi

echo
echo "==> Ready"
echo "    Server:      http://127.0.0.1:${PORT}"
if [ -n "$TOKEN" ]; then
  echo "    Token:       $TOKEN"
else
  echo "    Token:       (check data/extension-token.txt once the server has started)"
fi
echo "    Next steps:  chrome://extensions -> Developer mode -> Load unpacked -> select extension/"
echo "                 paste the token into the popup, then click Scan & Fill on a form page"
