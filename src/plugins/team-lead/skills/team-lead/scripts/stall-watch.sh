#!/usr/bin/env bash
#
# stall-watch.sh — token-free stall watchdog for Herdr agent teams.
#
# A "team" is a leader agent plus the dev agents it runs. The team is STALLED
# when none of its members has been `working` for --quiet-min minutes: every
# agent is idle/done, typically because a dev is waiting on its leader while
# the leader believes the dev is busy. The watchdog then prompts the leader
# once per quiet episode with each member's status and the last lines of its
# pane. If the team is still quiet --quiet-min minutes after that, it
# escalates once to --escalate (e.g. the leader's own lead).
#
# A member stuck in a non-idle, non-working state (an approval dialog, an
# error) for two consecutive ticks is reported to the leader right away, even
# while other members work.
#
# It never reads anything into a model's context unless there is something to
# act on; the loop itself costs no tokens. Run it in its own Herdr pane (so the
# user can see and stop it) or with nohup.
#
# Usage:
#   stall-watch.sh --team <leader>=<glob>[,<glob>...] [--team ...]
#                  [--escalate <agent>] [--quiet-min 15] [--interval 60]
#                  [--state-dir DIR] [--once] [--dry-run]
#   stall-watch.sh --snooze <leader> <minutes> [--state-dir DIR]
#
#   --team L=G      Leader agent name L; members are every Herdr agent whose
#                   name matches one of the comma-separated shell globs G
#                   (e.g. mx-squad-attr='mx-attr-*'). Repeatable.
#   --escalate A    Agent to notify when a leader does not react (optional).
#   --quiet-min N   Minutes with nobody working before alerting (default 15).
#   --interval S    Seconds between checks (default 60).
#   --state-dir D   Where per-team state lives (default ${TMPDIR:-/tmp}/stall-watch).
#   --once          Run a single check and exit (for testing / cron).
#   --dry-run       Print the messages instead of sending them.
#   --snooze L M    Silence team L for M minutes (a leader legitimately waiting
#                   on the user, CI, or a merge). The alert text tells the
#                   leader how to run this.
#
# Messages are delivered with `herdr agent prompt`, only to an agent that is
# not `working` (a prompt sent to a working agent lands unsubmitted in its
# input box). If the target is working, delivery is retried on the next tick.

set -uo pipefail

QUIET_MIN=15
INTERVAL=60
STATE_DIR="${TMPDIR:-/tmp}/stall-watch"
ESCALATE=""
ONCE=0
DRY=0
TEAMS=()
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

die() { echo "stall-watch: $*" >&2; exit 2; }

if [[ "${1:-}" == "--snooze" ]]; then
  [[ $# -ge 3 ]] || die "usage: --snooze <leader> <minutes> [--state-dir DIR]"
  leader="$2"; minutes="$3"; shift 3
  [[ "${1:-}" == "--state-dir" ]] && STATE_DIR="$2"
  mkdir -p "$STATE_DIR"
  echo $(( $(date +%s) + minutes * 60 )) > "$STATE_DIR/$leader.snooze"
  echo "stall-watch: $leader snoozed for ${minutes}m"
  exit 0
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --team) TEAMS+=("$2"); shift 2 ;;
    --escalate) ESCALATE="$2"; shift 2 ;;
    --quiet-min) QUIET_MIN="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    --once) ONCE=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,45p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ ${#TEAMS[@]} -gt 0 ]] || die "at least one --team is required"
command -v herdr >/dev/null || die "herdr not found"
command -v jq >/dev/null || die "jq not found"
mkdir -p "$STATE_DIR"

log() { echo "$(date +%H:%M:%S) $*"; }

# Last few meaningful lines of an agent's pane, joined on one line.
pane_tail() {
  herdr agent read "$1" --lines 40 2>/dev/null \
    | sed -e 's/[[:space:]]\+$//' \
    | grep -vE '^[[:space:]]*$|^[─━╭╰│┊ ]+$|^[[:space:]]*[❯›>][[:space:]]*$|bypass permissions|shift\+tab|Ask Codex|new task\?|How is Claude doing' \
    | tail -n 6 | cut -c1-160 | paste -sd'|' - | sed 's/|/ | /g'
}

status_of() { jq -r --arg n "$1" '.result.agents[] | select(.name==$n) | .agent_status // "unknown"' <<<"$AGENTS" | head -1; }

deliver() { # target message -> 0 delivered, 1 retry later
  local target="$1" msg="$2" st
  st="$(status_of "$target")"
  if [[ -z "$st" ]]; then log "cannot deliver to $target: no such agent"; return 1; fi
  if [[ "$st" == "working" ]]; then log "defer message to $target (working)"; return 1; fi
  if [[ $DRY -eq 1 ]]; then log "DRY-RUN → $target: $msg"; return 0; fi
  if herdr agent prompt "$target" "$msg" >/dev/null 2>&1; then log "sent → $target"; return 0; fi
  log "herdr agent prompt to $target failed"; return 1
}

check_team() {
  local spec="$1" leader="${1%%=*}" globs="${1#*=}"
  local sf="$STATE_DIR/$leader.state" now; now=$(date +%s)
  local last_active alerted escalated
  last_active=$now; alerted=0; escalated=0
  # shellcheck disable=SC1090
  [[ -f "$sf" ]] && source "$sf"

  local snooze=0
  [[ -f "$STATE_DIR/$leader.snooze" ]] && snooze=$(cat "$STATE_DIR/$leader.snooze")

  # members: leader + agents matching any glob
  local names member_lines="" any_working=0 m st
  names=$(jq -r '.result.agents[] | select(.name != null) | .name' <<<"$AGENTS")
  local members=("$leader")
  IFS=',' read -ra gl <<<"$globs"
  while read -r m; do
    [[ -z "$m" || "$m" == "$leader" ]] && continue
    for g in "${gl[@]}"; do
      # shellcheck disable=SC2053
      if [[ "$m" == $g ]]; then members+=("$m"); break; fi
    done
  done <<<"$names"

  for m in "${members[@]}"; do
    st="$(status_of "$m")"; [[ -z "$st" ]] && st="missing"
    member_lines+="$m=$st; "
    [[ "$st" == "working" ]] && any_working=1
    # stuck in a non-idle, non-working state (approval dialog, error) two ticks in a row
    local bf="$STATE_DIR/$leader.$m.odd"
    case "$st" in
      working|idle|done|missing) rm -f "$bf" ;;
      *)
        if [[ -f "$bf" && "$(cat "$bf")" != "sent" && $m != "$leader" ]]; then
          if deliver "$leader" "stall-watch: $m has been '$st' for 2+ checks (likely an approval dialog or an error). Last lines: $(pane_tail "$m")"; then
            echo sent > "$bf"
          fi
        elif [[ ! -f "$bf" ]]; then echo seen > "$bf"; fi ;;
    esac
  done

  if [[ $any_working -eq 1 ]]; then
    last_active=$now; alerted=0; escalated=0
  elif (( now >= snooze )); then
    local quiet=$(( (now - last_active) / 60 ))
    if (( alerted == 0 && quiet >= QUIET_MIN )); then
      local detail=""
      for m in "${members[@]}"; do
        [[ "$m" == "$leader" ]] && continue
        detail+=" [$m, $(status_of "$m"): $(pane_tail "$m")]"
      done
      local msg="stall-watch: nobody on your team has been working for ${quiet}m ($member_lines). A dev may be waiting on you, or you on it. Check each and unblock it; if the team is legitimately waiting (user, CI, merge), run: $SELF --snooze $leader <minutes> --state-dir $STATE_DIR.${detail}"
      deliver "$leader" "$msg" && alerted=$now
    elif (( alerted > 0 && escalated == 0 )) && [[ -n "$ESCALATE" ]] && (( (now - alerted) / 60 >= QUIET_MIN )); then
      local msg="stall-watch: team $leader is still quiet $(( (now - alerted) / 60 ))m after its leader was alerted ($member_lines). The leader may be stuck or waiting on you. Leader's last lines: $(pane_tail "$leader")"
      deliver "$ESCALATE" "$msg" && escalated=$now
    fi
  fi

  printf 'last_active=%s\nalerted=%s\nescalated=%s\n' "$last_active" "$alerted" "$escalated" > "$sf"
  log "$leader: ${member_lines}quiet $(( (now - last_active) / 60 ))m"
}

while :; do
  if AGENTS="$(herdr agent list 2>/dev/null)" && jq -e '.result.agents' >/dev/null 2>&1 <<<"$AGENTS"; then
    for t in "${TEAMS[@]}"; do check_team "$t"; done
  else
    log "herdr agent list failed; retrying"
  fi
  [[ $ONCE -eq 1 ]] && break
  sleep "$INTERVAL"
done
