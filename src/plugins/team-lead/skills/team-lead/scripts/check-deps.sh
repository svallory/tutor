#!/usr/bin/env bash
#
# check-deps.sh — verify the CLI tooling the team-lead skill needs, in one call.
#
# Checks the base tools every team needs, Herdr when running inside it, and
# whatever each harness in the saved harness config needs (its CLI, and for pi
# the pi-claude-link extension unless the config says `messaging: herdr`). It
# also validates each harness's `env:` block: variable names must be valid, and
# every `defaults:` key must also be listed under `inherit:`.
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
  [ -n "$("${SHELL:-zsh}" -ic 'command -v -- "$1"' _ "$1" 2>/dev/null | tail -1)" ]
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
    function envname(line,   k) {
      k = line
      sub(/^[[:space:]]*-?[[:space:]]*/, "", k)
      sub(/:.*$/, "", k)
      sub(/[[:space:]]+#.*$/, "", k)
      gsub(/^["\047]|["\047]$/, "", k)
      return k
    }
    function add_inherit(list,   n, i, parts) {
      sub(/[[:space:]]+#.*$/, "", list)
      if (index(list, "[")) list = substr(list, index(list, "[") + 1)
      sub(/\][[:space:]]*$/, "", list)
      n = split(list, parts, /[[:space:]]*,[[:space:]]*/)
      for (i = 1; i <= n; i++) {
        gsub(/^[[:space:]"\047]+|[[:space:]"\047]+$/, "", parts[i])
        if (parts[i] != "") { inherit[parts[i]] = 1; check_name(parts[i], "inherit") }
      }
    }
    function check_name(v, where) {
      if (v !~ /^[A-Za-z_][A-Za-z0-9_]*$/) print "E" sep name sep "invalid variable name in env." where ": " v
    }
    function emit(   binary, first, k) {
      if (name == "") return
      for (k in defaults) if (!(k in inherit))
        print "E" sep name sep "env.defaults." k " has no matching env.inherit entry; add " k " to inherit: or move it to set:"
      binary = bin
      if (binary == "") {
        first = launch
        sub(/^[[:space:]]*/, "", first)
        if (substr(first, 1, 1) == "\"" || substr(first, 1, 1) == "\047") first = substr(first, 2)
        sub(/[[:space:]"\047].*$/, "", first)
        if (first != "env" && first !~ /^[A-Za-z_][A-Za-z_0-9]*=/) binary = first
      }
      print "H" sep name sep binary sep messaging sep bin_set
    }
    BEGIN { sep = sprintf("%c", 31) }
    /^harnesses:/ { in_section = 1; next }
    /^[^ #]/      { in_section = 0 }
    !in_section   { next }
    /^  [A-Za-z0-9_-]+:[[:space:]]*$/ {
      emit(); name = $1; sub(/:$/, "", name); launch = ""; bin = ""; bin_set = 0; messaging = "-"
      delete inherit; delete defaults; env_key = ""; next
    }
    /^    [A-Za-z_]+:/ { env_key = "" }
    /^    launch:/    { launch = scalar($0) }
    /^    bin:/       { bin = scalar($0); gsub(/^["\047]|["\047]$/, "", bin); bin_set = 1 }
    /^    messaging:/ { messaging = scalar($0) }
    /^    env:/       { env_key = "env" }
    env_key == "" { next }
    /^      inherit:/  { env_key = "inherit"; if ($0 ~ /\[/) add_inherit($0); next }
    /^      defaults:/ { env_key = "defaults"; next }
    /^      set:/      { env_key = "set"; next }
    /^      [A-Za-z_]+:/ { env_key = "env"; next }
    env_key == "inherit"  && /^        -/ { add_inherit(envname($0)) }
    env_key == "defaults" && /^        [^ #-]/ { defaults[envname($0)] = 1; check_name(envname($0), "defaults") }
    env_key == "set"      && /^        [^ #-]/ { check_name(envname($0), "set") }
    END { emit() }
  ' "$config" > "${TMPDIR:-/tmp}/check-deps.$$"
  # Read from a file, not a pipe, so `report` runs in this shell and sets `missing`.
  while IFS=$'\037' read -r kind harness binary messaging bin_set; do
    if [ "$kind" = E ]; then
      report "valid env: block for $harness" "$binary"
      continue
    fi
    # Accept only a single literal executable token or path. Even the inferred
    # launch token must not contain shell syntax (or delimiters in this parser).
    if [ "$bin_set" = 1 ] && { [[ ! "$binary" =~ ^[A-Za-z0-9_./-]+$ ]] || [ "$binary" = env ]; }; then
      report "invalid bin: for $harness" "use one executable name or path without spaces or shell metacharacters"
    elif [ -z "$binary" ] || [ "$binary" = env ] || [[ "$binary" == *=* ]]; then
      report "cannot determine executable for $harness; add bin:" "set bin: to the harness CLI in harnesses.yaml"
    elif [[ ! "$binary" =~ ^[A-Za-z0-9_./-]+$ ]]; then
      report "invalid bin: for $harness" "use one executable name or path without spaces or shell metacharacters"
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
