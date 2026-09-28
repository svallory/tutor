---
name: sync-skills
description: Use when skills show up twice or not at all across agents that share ~/.agents/skills (Claude Code, Pi, Kimi, Codex, agy) — skill-name collision warnings, a claude.ai-synced skill appearing once per Claude account, ~/.claude/skills being a symlink to ~/.agents/skills, a new skill added to ~/.agents/skills that Claude doesn't see, or several Claude config dirs (~/.claude, ~/.claude-<name>). Triggers on "sync skills", "skill collision", "duplicate skills", "link skills".
---

# Sync skills

One shared skills folder, `~/.agents/skills`, is read by every agent. Claude Code also writes the skills you enabled on claude.ai into `<config dir>/skills/synced/<org>_<account>/`. When `<config dir>/skills` is a symlink to `~/.agents/skills`, those synced folders land in the shared folder, and an agent that scans it recursively sees every synced skill once per Claude account.

The bundled script keeps this layout:

| Path | Holds |
|------|-------|
| `~/.agents/skills/<name>/` | your own skills, as real folders |
| `~/.agents/skills/<name>` → a synced skill | one link per claude.ai skill, so other agents see each once |
| `<config dir>/skills/` | a real folder per Claude config dir |
| `<config dir>/skills/<name>` → `~/.agents/skills/<name>` | one link per skill of your own |
| `<config dir>/skills/synced/<org>_<account>/` | written by Claude; left alone |

## Run it

Preview first, then apply:

```bash
bash "$SKILL_DIR/skills/sync-skills/scripts/sync-skills.sh" --dry-run
bash "$SKILL_DIR/skills/sync-skills/scripts/sync-skills.sh"
```

By default it handles `~/.claude` plus every `~/.claude-*` folder that has a `.claude.json`. Pass config dirs as arguments to choose them yourself; the first one wins when two accounts sync a skill with the same name. `--agents-dir DIR` changes the shared folder. It needs `jq`.

What a run does:

1. Turns each config dir's `skills` symlink into a real folder.
2. Moves synced buckets found in `~/.agents/skills/synced/` to the config dir whose account owns them (matched through `.claude.json`'s `oauthAccount`), and Claude's `.trash` to the first config dir.
3. Links every skill of your own into each config dir, and removes links to skills that no longer exist.
4. Relinks the synced skills into `~/.agents/skills`, one per name. A skill of your own always wins over a synced one.
5. Reports any duplicate skill names left, and exits 1 if there are some.

It never deletes a real folder. It is safe to rerun.

## When to rerun

- After adding or removing a skill in `~/.agents/skills`, so Claude sees the change.
- After enabling or disabling skills on claude.ai, so other agents see the change.
- After restarting Claude sessions that started while `skills` was still a symlink. Such a session keeps writing its synced bucket into `~/.agents/skills/synced/` until it restarts; the script moves the bucket to its owner.

## Limits

- A real folder in a config dir's `skills` with the same name as a shared skill is left alone and reported; decide which one to keep.
- A synced bucket whose account matches no config dir stays in `~/.agents/skills/synced/` with a warning.
