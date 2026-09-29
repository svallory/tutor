#!/usr/bin/env bash
#
# check-deps.sh — verify the CLI tooling the team-lead skill needs, in one call.
#
# Checks the base tools every team needs, Herdr when running inside it, and
# whatever each harness in the saved harness config needs (its CLI, and for pi
# the pi-claude-link extension unless the config says `messaging: herdr`).
# Skills (worktrunk, code-review, herdr) cannot be checked from a shell; the
# lead checks those against its own skills listing.
#
# Usage:
#   check-deps.sh [--config <harnesses.yaml>]
#
# Output: nothing when everything is present. Otherwise one line per problem:
#   MISSING <what> — <how to fix>
#
# Exit status: 0 when everything is present, 1 when something is missing.

set -u

usage() { echo "usage: check-deps.sh [--config <harnesses.yaml>]" >&2; }
config=""
while [ $# -gt 0 ]; do
  case "$1" in
    --config)
      if [ $# -lt 2 ] || [ -z "$2" ] || [ "${2#--}" != "$2" ]; then usage; exit 2; fi
      config="$2"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "check-deps.sh: unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

missing=0
report() { echo "MISSING $1 — $2"; missing=1; }

# Some harness CLIs are only on the interactive shell's PATH.
has_command() {
  command -v "$1" >/dev/null 2>&1 && return 0
  [ -n "$("${SHELL:-zsh}" -ic "command -v $1" 2>/dev/null | tail -1)" ]
}

has_command git   || report git   "install git"
has_command jq    || report jq    "brew install jq (or the platform's package manager)"
has_command wt    || report wt    "see https://github.com/max-sixty/worktrunk for install instructions"
has_command flock || report flock "brew install flock (macOS) or util-linux (Linux)"
if has_command gh; then
  gh auth status >/dev/null 2>&1 || report "gh authentication" "gh auth login"
else
  report gh "brew install gh (or the platform's package manager)"
fi

if [ "${HERDR_ENV:-}" = 1 ]; then
  has_command herdr || report herdr "HERDR_ENV=1 is set but the herdr CLI is not on PATH"
fi

if [ -n "$config" ] && [ -f "$config" ]; then
  # This is a deliberately small parser for the documented flat harness entries.
  # bin is authoritative; otherwise infer only a direct executable, never env or
  # an assignment (which could mask a missing command later in the launch).
  awk '
    function scalar(line) {
      sub(/^    [A-Za-z_]+:[[:space:]]*/, "", line)
      sub(/[[:space:]]+#.*$/, "", line)
      return line
    }
    function emit(   binary, first) {
      if (name == "") return
      binary = bin
      if (binary == "") {
        first = launch
        sub(/^[[:space:]]*/, "", first)
        if (substr(first, 1, 1) == "\"" || substr(first, 1, 1) == "\047") first = substr(first, 2)
        sub(/[[:space:]"\047].*$/, "", first)
        if (first != "env" && first !~ /^[A-Za-z_][A-Za-z_0-9]*=/) binary = first
      }
      print name "|" binary "|" messaging
    }
    /^harnesses:/ { in_section = 1; next }
    /^[^ #]/      { in_section = 0 }
    !in_section   { next }
    /^  [A-Za-z0-9_-]+:[[:space:]]*$/ {
      emit(); name = $1; sub(/:$/, "", name); launch = ""; bin = ""; messaging = "-"; next
    }
    /^    launch:/    { launch = scalar($0) }
    /^    bin:/       { bin = scalar($0); gsub(/^["\047]|["\047]$/, "", bin) }
    /^    messaging:/ { messaging = scalar($0) }
    END { emit() }
  ' "$config" > "${TMPDIR:-/tmp}/check-deps.$$"
  # Read from a file, not a pipe, so `report` runs in this shell and sets `missing`.
  while IFS='|' read -r harness binary messaging; do
    if [ -z "$binary" ] || [ "$binary" = env ] || [[ "$binary" == *=* ]]; then
      report "cannot determine executable for $harness; add bin:" "set bin: to the harness CLI in harnesses.yaml"
    else
      has_command "$binary" || report "$harness ($binary)" "harness in the config is not installed; ask the user before dropping it"
    fi
    if [ "$harness" = pi ] && [ "$messaging" != herdr ] && has_command pi; then
      pi list 2>/dev/null | grep -q pi-claude-link ||
        report "pi-claude-link" "ask the user, then: pi install git:github.com/alonw0/pi-claude-link (or set messaging: herdr for pi)"
    fi
  done < "${TMPDIR:-/tmp}/check-deps.$$"
  rm -f "${TMPDIR:-/tmp}/check-deps.$$"
fi

exit "$missing"
