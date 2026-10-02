#!/usr/bin/env bash
#
# with-obscura.sh — run a command against a throwaway `obscura serve`.
#
# Starts the CDP server, waits until it answers, exports OBSCURA_CDP_URL for the
# command, and stops the server when the command exits (success, failure or
# signal), so no server is left running and no other obscura process is touched.
#
# Usage:
#   with-obscura.sh [--port <n>] [obscura serve flags...] -- <command> [args...]
#
#   --port <n>   use this port, and refuse if it is taken. Without it the first
#                free port from 9222 up is used.
#   Every other flag before `--` goes to `obscura serve` unchanged, for example
#   --allow-private-network (required to reach localhost), --stealth,
#   --storage-dir <dir>.
#
# Environment for the command:
#   OBSCURA_CDP_URL   ws://127.0.0.1:<port>
#
# Exit status: the command's own status; 2 on a usage error; 3 when the server
# could not be started (its log is printed).

set -u

usage() { echo "usage: with-obscura.sh [--port <n>] [obscura serve flags...] -- <command> [args...]" >&2; }

port=""
serve_args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --) shift; break ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -p|--port)
      if [ $# -lt 2 ]; then usage; exit 2; fi
      port="$2"; shift 2 ;;
    --port=*) port="${1#--port=}"; shift ;;
    *) serve_args+=("$1"); shift ;;
  esac
done
if [ $# -eq 0 ]; then usage; exit 2; fi
case "$port" in
  *[!0-9]*) echo "with-obscura.sh: --port must be a number, got '$port'" >&2; exit 2 ;;
esac

for tool in obscura curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "with-obscura.sh: $tool is not on PATH" >&2
    exit 3
  fi
done

in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

log=$(mktemp "${TMPDIR:-/tmp}/obscura-serve.XXXXXX")
pid=""
cmd_pid=""
# pids of this shell's background jobs (the server, the command) still alive.
# `jobs -p` rather than the saved pids, so a signal landing between
# `obscura serve &` and `pid=$!` still finds the server.
alive_jobs() {
  local job
  for job in $(jobs -p); do
    kill -0 "$job" 2>/dev/null && echo "$job"
  done
}

cleanup() {
  local left
  # the command first: it is the one talking to the server
  [ -n "$cmd_pid" ] && kill "$cmd_pid" 2>/dev/null
  # re-send instead of kill-once-and-wait: a signal that reaches a job between
  # its fork and its exec is swallowed, and a plain `wait` would then hang
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    left=$(alive_jobs)
    [ -z "$left" ] && break
    # shellcheck disable=SC2086  # one pid per word
    kill $left 2>/dev/null
    sleep 0.1
  done
  left=$(alive_jobs)
  # shellcheck disable=SC2086
  [ -n "$left" ] && kill -9 $left 2>/dev/null
  # reap here with stderr closed, or bash reports the killed job on exit
  wait 2>/dev/null
  rm -f "$log"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# start_on <port>: 0 when the server answers, 1 when it exited or never answered
start_on() {
  obscura serve --port "$1" ${serve_args[@]+"${serve_args[@]}"} >"$log" 2>&1 &
  pid=$!

  for _ in $(seq 1 100); do
    kill -0 "$pid" 2>/dev/null || { wait "$pid" 2>/dev/null; pid=""; return 1; }
    if curl -fsS -o /dev/null "http://127.0.0.1:$1/json/version" 2>/dev/null; then
      # obscura 0.2.3 hangs on a SIGTERM that arrives within ~10 ms of its first
      # answer, and then only SIGKILL stops it; give it a moment so a command
      # that exits at once still gets a clean shutdown
      sleep 0.1
      return 0
    fi
    sleep 0.1
  done
  return 1
}

fail_start() {
  echo "with-obscura.sh: $1" >&2
  sed '/^[[:space:]]*$/d; s/^/  obscura: /' "$log" >&2
  exit 3
}

if [ -n "$port" ]; then
  in_use "$port" && { echo "with-obscura.sh: port $port is already in use; stop what holds it or drop --port to pick a free one" >&2; exit 3; }
  start_on "$port" || fail_start "obscura serve did not come up on port $port"
else
  started=0
  for candidate in $(seq 9222 9241); do
    in_use "$candidate" && continue
    # a port taken between the check and the bind makes obscura exit; try the next
    if start_on "$candidate"; then port=$candidate; started=1; break; fi
    grep -q "Address already in use" "$log" || fail_start "obscura serve did not come up on port $candidate"
  done
  [ "$started" = 1 ] || fail_start "no free port between 9222 and 9241"
fi

# in the background and waited on, because a trap cannot interrupt a foreground
# command: a signal would otherwise leave the server up until the command ends
OBSCURA_CDP_URL="ws://127.0.0.1:$port" "$@" <&0 &
cmd_pid=$!
wait "$cmd_pid"
status=$?
cmd_pid=""
exit "$status"
