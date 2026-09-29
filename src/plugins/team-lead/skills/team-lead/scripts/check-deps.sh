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

config=""
while [ $# -gt 0 ]; do
  case "$1" in
    --config) config="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "check-deps.sh: unknown argument: $1" >&2; exit 2 ;;
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
  # Emit "<harness> <first word of launch> <messaging>" for each entry under `harnesses:`.
  awk '
    /^harnesses:/ { in_section = 1; next }
    /^[^ #]/      { in_section = 0 }
    !in_section   { next }
    /^  [A-Za-z0-9_-]+:[[:space:]]*$/ {
      if (name != "") print name, launch, messaging
      name = $1; sub(/:$/, "", name); launch = name; messaging = "-"
      next
    }
    /^    launch:/    { launch = $2 }
    /^    messaging:/ { messaging = $2 }
    END { if (name != "") print name, launch, messaging }
  ' "$config" > "${TMPDIR:-/tmp}/check-deps.$$"
  # Read from a file, not a pipe, so `report` runs in this shell and sets `missing`.
  while read -r harness binary messaging; do
    has_command "$binary" || report "$harness ($binary)" "harness in the config is not installed; ask the user before dropping it"
    if [ "$harness" = pi ] && [ "$messaging" != herdr ] && has_command pi; then
      pi list 2>/dev/null | grep -q pi-claude-link ||
        report "pi-claude-link" "ask the user, then: pi install git:github.com/alonw0/pi-claude-link (or set messaging: herdr for pi)"
    fi
  done < "${TMPDIR:-/tmp}/check-deps.$$"
  rm -f "${TMPDIR:-/tmp}/check-deps.$$"
fi

exit "$missing"
