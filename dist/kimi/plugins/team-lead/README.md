# Team Lead plugin

Act as a dev team leader: decompose a batch of tasks (sprint, board, epic, list of tickets), assign them to developer subagents at the cheapest adequate model, review their work, and track progress to done.

## What it does

The `team-lead` skill turns the agent into an orchestrator that does not write feature code itself:

- **Collects and clarifies tasks** — dispatches read-only researcher agents to answer what the code can answer before asking you anything
- **Picks models per task** — haiku for research/mechanical edits, sonnet for normal development, opus for gnarly work, with escalation when a dev gets stuck
- **Provisions one git worktree per task** via [worktrunk](https://github.com/max-sixty/worktrunk) (`wt`), optionally driving one Herdr tab per dev when `HERDR_ENV=1`
- **Reviews and integrates** — acceptance review per task, independent `code-review` pass on PRs, progress tracking across the whole batch

## Requirements

Checked once per session on first invocation; the skill stops and tells you what's missing rather than working around it silently.

| Dependency | Required for |
|---|---|
| `git`, `gh` (authenticated), `jq` | everything / PRs / JSON parsing |
| `wt` (worktrunk) + `worktrunk` skill | one worktree per task |
| `code-review` skill | independent post-acceptance PR review |
| `herdr` CLI + skill | only when `HERDR_ENV=1` |
| `but` (GitButler) | only for projects that use it |
| `flock` | serializing heavy or order-sensitive work |

## Install

```
/plugin install team-lead@tutor
```

Or via the [skills CLI](https://skills.sh):

```
npx skills add svallory/tutor --skill team-lead
```

## Usage

Hand it a batch: "start dev agents on these tasks", "team-lead this sprint", "assign these tickets to devs". Triggers on "team lead", "dev leader", "squad leader".
