# Sync Skills

Keeps one shared skills folder, `~/.agents/skills`, for every agent (Claude Code, Pi, Kimi, Codex, agy) without duplicate skill names.

Claude Code writes the skills you enabled on claude.ai into `<config dir>/skills/synced/<org>_<account>/`. If `~/.claude/skills` (or `~/.claude-<name>/skills`) is a symlink to `~/.agents/skills`, those folders land in the shared folder, and agents that scan it recursively see each synced skill once per Claude account.

The `sync-skills` skill runs a bundled script that:

- makes each Claude config dir's `skills` a real folder, with one link per skill of yours in `~/.agents/skills`;
- moves synced buckets back to the config dir whose account owns them;
- links each claude.ai skill into `~/.agents/skills` once, so other agents still see it.

## Contents

```
skills/sync-skills/
├── SKILL.md                 # When and how to run it
└── scripts/sync-skills.sh   # The script (bash, needs jq)
```

## Usage

```bash
scripts/sync-skills.sh --dry-run   # preview
scripts/sync-skills.sh             # apply; safe to rerun
```

Rerun after adding a skill to `~/.agents/skills`, after changing your claude.ai skills, or after restarting Claude sessions that started while `skills` was a symlink.
