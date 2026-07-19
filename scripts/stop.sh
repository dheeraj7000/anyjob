#!/usr/bin/env bash
# Stops the anyjob server / DeepSeek daemon, but only the ones start.sh
# itself launched (tracked via data/*.pid) -- leaves anything else alone.
set -euo pipefail
cd "$(dirname "$0")/.."

stop_pid_file() {
  local label="$1" file="$2"
  if [ -f "$file" ] && kill -0 "$(cat "$file")" 2>/dev/null; then
    kill "$(cat "$file")"
    echo "Stopped $label (pid $(cat "$file"))"
  else
    echo "$label not running (or not started by start.sh)"
  fi
  rm -f "$file"
}

stop_pid_file "anyjob server" "data/server.pid"
stop_pid_file "anyapi DeepSeek daemon" "data/deepseek-daemon.pid"
