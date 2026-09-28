#!/usr/bin/env bash
# sync-skills.sh — keep one shared skills folder for every agent, without
# duplicate skill names.
#
# Layout it maintains:
#   ~/.agents/skills/<name>            your own skills (real folders), read by
#                                      every agent (Pi, Kimi, Codex, agy, ...)
#   ~/.agents/skills/<name> -> <cfg>/skills/synced/<bucket>/<name>
#                                      one link per skill synced from claude.ai,
#                                      so other agents see each one exactly once
#   <cfg>/skills/                      a REAL folder per Claude config dir
#   <cfg>/skills/<name> -> ~/.agents/skills/<name>
#                                      one link per skill of your own
#   <cfg>/skills/synced/<org>_<account>/
#                                      claude.ai skills, written by Claude itself
#
# Why: Claude Code writes claude.ai skills into <cfg>/skills/synced/. If
# <cfg>/skills is a symlink to ~/.agents/skills, every Claude account's
# synced folder lands where all agents scan recursively, and the same skill
# shows up once per account.
#
# Usage: sync-skills.sh [--dry-run] [--agents-dir DIR] [CLAUDE_CONFIG_DIR ...]
#   Default config dirs: ~/.claude plus every ~/.claude-* holding a .claude.json.
#   The first config dir wins when two accounts sync a skill with the same name.
#
# Safe to rerun. Never deletes a real folder; only creates, moves and removes
# symlinks, and moves synced buckets to the config dir that owns them.

set -euo pipefail

dry_run=0
agents_dir="$HOME/.agents/skills"
configs=()

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run|-n) dry_run=1 ;;
    --agents-dir) agents_dir="$2"; shift ;;
    -h|--help) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "sync-skills: unknown option $1" >&2; exit 2 ;;
    *) configs+=("${1%/}") ;;
  esac
  shift
done

command -v jq >/dev/null || { echo "sync-skills: jq is required" >&2; exit 1; }
[ -d "$agents_dir" ] || { echo "sync-skills: $agents_dir does not exist" >&2; exit 1; }

if [ ${#configs[@]} -eq 0 ]; then
  [ -d "$HOME/.claude" ] && configs+=("$HOME/.claude")
  for dir in "$HOME"/.claude-*; do
    [ -d "$dir" ] && [ -f "$dir/.claude.json" ] && configs+=("$dir")
  done
fi

run() {
  if [ "$dry_run" = 1 ]; then echo "would: $*"; else "$@"; fi
}

# The <org>_<account> id Claude names a config dir's synced bucket after.
account_key() {
  local config="$1" json
  if [ "$config" = "$HOME/.claude" ]; then json="$HOME/.claude.json"; else json="$config/.claude.json"; fi
  [ -f "$json" ] || return 0
  jq -r '.oauthAccount | select(.organizationUuid and .accountUuid) | "\(.organizationUuid)_\(.accountUuid)"' "$json" 2>/dev/null || true
}

points_into_synced() {
  [ -L "$1" ] && case "$(readlink "$1")" in */skills/synced/*) return 0 ;; esac
  return 1
}

# 1. Every Claude config dir gets a real skills folder.
converted=" "
for config in ${configs[@]+"${configs[@]}"}; do
  skills="$config/skills"
  if [ -L "$skills" ]; then
    converted="$converted$config "
    echo "convert $skills from a symlink ($(readlink "$skills")) to a real folder"
    run rm "$skills"
    run mkdir -p "$skills"
  elif [ ! -e "$skills" ]; then
    run mkdir -p "$skills"
  fi
done

# 2. Move synced buckets that landed in the shared folder to their owner.
if [ -d "$agents_dir/synced" ] && [ ! -L "$agents_dir/synced" ]; then
  for bucket in "$agents_dir"/synced/*/; do
    [ -d "$bucket" ] || continue
    bucket="${bucket%/}"
    key="$(basename "$bucket")"
    owner=""
    for config in ${configs[@]+"${configs[@]}"}; do
      [ "$(account_key "$config")" = "$key" ] && { owner="$config"; break; }
    done
    if [ -z "$owner" ]; then
      echo "warning: no config dir owns synced bucket $key; left in place" >&2
      continue
    fi
    target="$owner/skills/synced"
    if [ -e "$target/$key" ] && [ "$bucket" -nt "$target/$key" ]; then
      echo "replace $target/$key with the newer copy of bucket $key"
      run rm -rf "$target/$key"
      run mv "$bucket" "$target/"
    elif [ -e "$target/$key" ]; then
      echo "remove older copy of bucket $key ($target/$key is current)"
      run rm -rf "$bucket"
    else
      echo "move bucket $key to $target"
      run mkdir -p "$target"
      run mv "$bucket" "$target/"
    fi
    [ -f "$agents_dir/synced/.bucket-$key" ] && run rm "$agents_dir/synced/.bucket-$key"
  done
  if [ "$dry_run" = 0 ] && [ -z "$(ls -A "$agents_dir/synced" 2>/dev/null)" ]; then
    rmdir "$agents_dir/synced"
  fi
fi

# Claude's own trash for synced skills belongs with the first config dir.
if [ -d "$agents_dir/.trash" ] && [ ${#configs[@]} -gt 0 ] && [ ! -e "${configs[0]}/skills/.trash" ]; then
  echo "move $agents_dir/.trash to ${configs[0]}/skills/.trash"
  run mv "$agents_dir/.trash" "${configs[0]}/skills/.trash"
fi

# 3. Your own skills: shared-folder entries with a SKILL.md that are not
#    links into a synced bucket.
own=()
for entry in "$agents_dir"/*; do
  [ -f "$entry/SKILL.md" ] || continue
  points_into_synced "$entry" && continue
  own+=("$(basename "$entry")")
done

is_own() {
  local name
  for name in ${own[@]+"${own[@]}"}; do [ "$name" = "$1" ] && return 0; done
  return 1
}

# 4. Each config dir links every skill of your own; stale links go.
for config in ${configs[@]+"${configs[@]}"}; do
  skills="$config/skills"
  added=0 removed=0
  # In a dry run a symlinked skills dir still shows the shared folder's
  # contents; treat it as the empty folder it is about to become.
  pending=0
  case "$converted" in *" $config "*) [ "$dry_run" = 1 ] && pending=1 ;; esac
  for link in "$skills"/*; do
    [ "$pending" = 1 ] && break
    [ -L "$link" ] || continue
    case "$(readlink "$link")" in
      "$agents_dir"/*)
        if [ ! -e "$link" ] || ! is_own "$(basename "$link")"; then
          run rm "$link"; removed=$((removed + 1))
        fi ;;
    esac
  done
  for name in ${own[@]+"${own[@]}"}; do
    if [ "$pending" = 0 ] && [ -L "$skills/$name" ]; then continue; fi
    if [ "$pending" = 0 ] && [ -e "$skills/$name" ]; then
      echo "warning: $skills/$name is a real folder; not linking the shared skill of that name" >&2
      continue
    fi
    run ln -s "$agents_dir/$name" "$skills/$name"; added=$((added + 1))
  done
  echo "$skills: +$added -$removed links (${#own[@]} own skills)"
done

# 5. Other agents see each synced skill once: drop old links, relink with the
#    first config dir winning name clashes. Names you own always win.
for link in "$agents_dir"/*; do
  points_into_synced "$link" && run rm "$link"
done
linked=0
declare -a taken=()
for config in ${configs[@]+"${configs[@]}"}; do
  for bucket in "$config"/skills/synced/*/; do
    [ -d "$bucket" ] || continue
    for skill in "$bucket"*/; do
      skill="${skill%/}"
      name="$(basename "$skill")"
      [ -f "$skill/SKILL.md" ] || continue
      is_own "$name" && continue
      clash=0
      for seen in "${taken[@]+"${taken[@]}"}"; do [ "$seen" = "$name" ] && clash=1; done
      [ "$clash" = 1 ] && continue
      taken+=("$name")
      run ln -s "$skill" "$agents_dir/$name"; linked=$((linked + 1))
    done
  done
done
echo "$agents_dir: $linked links to synced skills"

# 6. Report duplicate skill names left in any root (top-level entries only).
[ "$dry_run" = 1 ] && exit 0
status=0
roots=("$agents_dir")
for config in ${configs[@]+"${configs[@]}"}; do roots+=("$config/skills"); done
for root in "${roots[@]}"; do
  dups="$(for entry in "$root"/* "$root"/synced/*/*; do
            [ -f "$entry/SKILL.md" ] || continue
            sed -n 's/^name:[[:space:]]*//p' "$entry/SKILL.md" | head -1 | tr -d "\"'"
          done | sort | uniq -d | tr '\n' ' ')"
  if [ -n "$dups" ]; then
    echo "duplicate skill names in $root: $dups" >&2
    status=1
  fi
done
exit "$status"
