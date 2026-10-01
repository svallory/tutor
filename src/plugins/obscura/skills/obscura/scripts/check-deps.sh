#!/usr/bin/env bash
#
# check-deps.sh — verify what the obscura skill needs, in one call.
#
# Always checks the obscura binary. Each flag adds the checks one workflow needs:
#   --scrape              obscura-worker next to obscura (parallel `obscura scrape`)
#   --render              a render-enabled build (screenshots, PDF, live view)
#   --serve               curl (with-obscura.sh polls the CDP endpoint with it)
#   --playwright <dir>    a Playwright package resolvable from <dir>
#
# Usage:
#   check-deps.sh [--scrape] [--render] [--serve] [--playwright <project-dir>]
#
# Output: nothing when everything is present. Otherwise one line per problem:
#   MISSING <what> — <how to fix>
#
# Exit status: 0 when everything is present, 1 when something is missing,
# 2 on a usage error.

set -u

usage() { echo "usage: check-deps.sh [--scrape] [--render] [--serve] [--playwright <project-dir>]" >&2; }

scrape=0 render=0 serve=0 playwright_dir=""
while [ $# -gt 0 ]; do
  case "$1" in
    --scrape) scrape=1; shift ;;
    --render) render=1; shift ;;
    --serve) serve=1; shift ;;
    --playwright)
      if [ $# -lt 2 ] || [ -z "$2" ] || [ "${2#--}" != "$2" ]; then usage; exit 2; fi
      playwright_dir="$2"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

missing=0
miss() { echo "MISSING $1 — $2"; missing=1; }

releases="https://github.com/h4ckf0r0day/obscura/releases"

obscura_bin=$(command -v obscura 2>/dev/null || true)
if [ -z "$obscura_bin" ]; then
  miss "obscura" "download the archive for this platform from $releases and put obscura and obscura-worker on PATH"
else
  if [ "$scrape" = 1 ] && [ ! -x "$(dirname "$obscura_bin")/obscura-worker" ]; then
    miss "obscura-worker" "'obscura scrape' needs it in the same directory as obscura ($(dirname "$obscura_bin")); it ships in the same archive"
  fi
  if [ "$render" = 1 ]; then
    # about:blank needs no network, so this tells a no-render build apart from
    # a network problem
    shot=$(mktemp "${TMPDIR:-/tmp}/obscura-render.XXXXXX")
    obscura fetch about:blank --screenshot "$shot" --quiet >/dev/null 2>&1
    if [ ! -s "$shot" ]; then
      miss "render build" "this obscura cannot take screenshots; use an archive without the -no-render suffix from $releases"
    fi
    rm -f "$shot"
  fi
fi

if [ "$serve" = 1 ] && ! command -v curl >/dev/null 2>&1; then
  miss "curl" "with-obscura.sh uses it to wait for the CDP endpoint; install curl"
fi

if [ -n "$playwright_dir" ]; then
  if [ ! -d "$playwright_dir" ]; then
    miss "project directory $playwright_dir" "pass the directory the Playwright script or tests run from"
  else
    # walk up like Node's resolver does, so a hoisted workspace install counts
    dir=$(cd "$playwright_dir" && pwd)
    found=0
    while :; do
      for pkg in @playwright/test playwright playwright-core; do
        [ -f "$dir/node_modules/$pkg/package.json" ] && found=1
      done
      [ "$found" = 1 ] && break
      parent=$(dirname "$dir")
      [ "$parent" = "$dir" ] && break
      dir=$parent
    done
    if [ "$found" = 0 ]; then
      miss "playwright" "no @playwright/test, playwright or playwright-core is installed for $playwright_dir; ask the user before adding one (playwright-core is enough to connect, and no browser download is needed)"
    fi
  fi
fi

exit "$missing"
