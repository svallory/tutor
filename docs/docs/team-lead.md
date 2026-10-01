# Team Lead

Act as a dev team leader: decompose a batch of tasks, assign them to developer agents at the cheapest adequate model, review their work, and track progress across a sprint, board, epic, or list of tickets.

The core idea: **the lead does not write feature code.** It decomposes, assigns, guides, reviews, and tracks. Its context window is the team's scarcest resource, so every lookup goes to a cheap subagent rather than into the lead's own context.

## Install

```
/plugin marketplace add svallory/tutor
/plugin install team-lead@tutor
```

Or as a standalone skill via the [skills CLI](https://skills.sh):

```
npx skills add svallory/tutor --skill team-lead
```

## Requirements

Checked once per session by `check-deps.sh` (skills are checked against the agent's skills list). If something is missing, the skill **stops before spawning any dev** and tells you how to fix it rather than silently working around it.

| Dependency | Required for |
|---|---|
| `git` | everything |
| `gh` (authenticated) | PR creation and listing |
| `jq` | parsing `wt` and `gh` JSON output |
| `wt` ([worktrunk](https://github.com/max-sixty/worktrunk)) + the `worktrunk` skill | one git worktree per task |
| `code-review` skill | independent post-acceptance PR review |
| `herdr` CLI + skill | only when `HERDR_ENV=1` — one tab per dev and automated monitoring |
| `but` (GitButler) | only for projects that use it |
| `flock` | serializing heavy or order-sensitive work (macOS: `brew install flock`) |
| the CLI of each configured harness | launching devs on it |
| [`pi-claude-link`](https://github.com/alonw0/pi-claude-link) | when pi is configured for socket messaging with Claude Code; not needed with `messaging: herdr` (install: `pi install git:github.com/alonw0/pi-claude-link`) |

A missing `herdr` while `HERDR_ENV=1` is reported as a contradiction, not quietly downgraded.

## Usage

Hand it a batch of work:

> team-lead this sprint

> start dev agents on these tasks

> assign these tickets to devs

Triggers on **"team lead"**, **"dev leader"**, **"squad leader"**, **"start dev agents on these tasks"**, **"assign tasks to devs"**.

## Harnesses

On first use the lead detects which coding-agent CLIs are installed (Claude Code, Codex, Kimi, pi, Gemini, and others), asks which ones you want on the team, and saves your choice plus a role → `harness:model` routing to `harnesses.yaml` in a persistent user directory (`${CLAUDE_PLUGIN_DATA}` for Claude, `${XDG_CONFIG_HOME:-$HOME/.config}/team-lead` for Kimi/standalone). The file is plain YAML; edit it by hand or ask the lead to "reconfigure harnesses".

For multi-provider harnesses the lead lists what can actually run rather than guessing: `pi --list-models` shows only providers with credentials configured.

### Dev environment

A dev's shell does not inherit the lead's environment, so a lead running under a non-default config directory (say `CLAUDE_CONFIG_DIR` pointing at a work account) would otherwise spawn devs on the personal account. Each harness entry in `harnesses.yaml` takes an `env:` block that says which variables cross that boundary:

```yaml
harnesses:
  claude:
    launch: claude --model <model>
    herdr_kind: claude
    env:
      inherit: [CLAUDE_CONFIG_DIR]      # copied from the lead's env when set there
      defaults:                         # used when a listed var is unset in the lead's env
        CLAUDE_CONFIG_DIR: ~/.claude-work
      set:                              # always this value
        DISABLE_AUTOUPDATER: "1"
```

Only listed variables are passed, so session-specific values never leak into a dev. Setup writes the `inherit` list for each known harness (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR`) by default; `check-deps.sh` rejects a `defaults` key that is not also in `inherit`. Inside Herdr the pairs become `--env` flags on `herdr tab create`; elsewhere they prefix the launch command.

## Roles and models

The lead picks the cheapest role that will finish in one or two attempts, escalating one tier when a dev gets stuck. It never starts at the top tier "to be safe".

| Role | Model | Use for |
|---|---|---|
| Researcher | haiku | Codebase and web searches, "where is X", "how does Y work", collecting facts |
| Mechanic | haiku | Purely mechanical edits: renames, moving files, applying a known pattern to N places, formatting |
| Developer | sonnet | Default for normal tasks: features, bug fixes, tests, small refactors |
| Senior Dev | opus | Tricky concurrency, gnarly types, subtle bugs, multi-system changes |
| Squad Leader | opus | A lead for one feature — may spawn its own devs and reports back at the end; Fable only on explicit request |

The model names above are what the `claude` platform build pins. On platforms without a model tier map, the skill ships a generic version of this table and you map the roles to your harness's own tiers.

Two overrides to the table:

- A "mechanical" change touching a **DB schema, migration, API contract, or serialized key is not mechanical** — a Researcher goes first, then Sonnet.
- **Unknown-effort tasks** (flaky tests, perf, "sometimes breaks") start at Sonnet with a brief demanding a reproduction before any fix. If there's no repro in 3 attempts, that report *is* the deliverable and it escalates to Opus with it.

A Squad Leader is launched when work spans 3+ layers or 2+ apps and needs design decisions, when a data migration touches persisted data, when the plan needs investigation before it can be written, or when coordination would exceed ~30 minutes of the lead's context.

## The workflow

**0. Load the project skill.** If a company or project skill exists for the working directory, it's loaded first — it fixes the base branch, deployment flow, package manager, and test commands. The skill never assumes `main` is the base.

**1. Collect tasks.** For each task the lead records ref, title, acceptance criteria, dependencies, and files likely touched, dispatching one Researcher per unclear task. Researchers also check whether the task is *already done* on the base branch, since stale boards are common.

Two rules govern this step:

- **Clarity gate** — the lead does not ask you anything until a Researcher has read the code. Only genuine product decisions reach you, one line each with the lead's default.
- **Never look yourself** — no `rg`, `cat`, `git log`, or file reads in the lead's own context. Every lookup goes to a cheap agent.

**2. Derive a task ref.** A kebab slug of 1–3 words, unique within the batch — "Allow Admin to add / edit Action Types" becomes `action-types`.

**3. Plan the batch.** Independent tasks are grouped for parallel work; same-file or dependent tasks are serialized. You get a table of ref, role/model, dependencies, and worktree before anything launches.

**4. Provision workspaces.** One worktree per task on a branch named `<type>/<task-ref>` where type is `feat`, `fix`, `chore`, or `refactor`:

```bash
wt switch --create "$BRANCH" --base "$BASE" --no-cd -y
WORKTREE=$(wt list --format json | jq -r --arg b "$BRANCH" '.items[] | select(.branch==$b) | .path')
```

**5–7. Launch, brief, and monitor.** Devs run in the background — inside [Herdr](https://github.com/herdrdev/herdr), each in its own one-pane tab you can watch and take over. The lead acts on completion messages and monitor alerts rather than polling.

**8. Review and ship.** On acceptance the dev pushes and opens a PR, and a **fresh** agent — never the author, so it isn't anchored on the dev's reasoning — runs `/code-review` on the PR number.

**9–10. Project extras and report.** Release notes, changelog, or docs from the project skill, then a final report of done / in review / blocked / not started.

## Definition of done

All five conditions are required:

1. Every acceptance criterion implemented.
2. Lint, typecheck, tests, and build each pass — **output reported, not claimed**.
3. A PR against the project's base branch, template filled, with a human title and tracker link.
4. Reviewed by a **separate** agent reporting **no bugs and no improvements**. Findings send it back; done requires a clean pass.
5. Any extras required by the project skill.

## The dev brief

Every dev gets a 12-part brief. The parts that matter most in practice:

- **Time budget** — `S` (one layer, ≤3 files) 15 min, `M` (2–3 layers) 45 min, `L` (multi-app or infra) 90 min. Anything bigger is split or given a Squad Leader. Over budget means stop, write a `STATUS: OVER-BUDGET` report, and go idle.
- **Stuck rule** — max 3 attempts. On the third failure the dev stops and reports what it tried and observed. No fourth approach, no widening scope.
- **Load rule** — devs work inline and never fork the whole task into a subagent. They must not start the app or any long-running stack without explicit pre-authorization.
- **Report format** — a file whose first line is `STATUS: DONE`, `BLOCKED`, or `NEEDS-USER`, followed by what changed, how it was verified (commands and counts), decisions, and open questions.
- **Completion signal** — one message to the lead whose first line is `STATUS: DONE|BLOCKED|NEEDS-USER — <task-ref>`. Going idle without sending it means the lead never learns the dev finished.

Two principles shape every brief: only include facts a Researcher confirmed exist on the base branch, and *give the dev the facts, not your reasoning about them* — a dev that receives the lead's analysis will follow the analysis instead of reading the code.

## Agent messaging

Agents message each other over the best channel the pair supports:

| Sender → receiver | Channel |
|---|---|
| Claude Code ↔ Claude Code | `SendMessage` / `/list-agents` |
| Claude Code → pi | `SendMessage` (pi runs `pi-claude-link`, launched with `--name`) |
| pi → Claude Code | pi's `claude-link` tool |
| any other pair | `herdr agent prompt` |

The order matters because `herdr agent prompt` types into the receiver's terminal: if you are typing in that pane at the same moment, the two inputs get mixed. `SendMessage` and `claude-link` use Claude Code's cross-session sockets and never touch the terminal.

Known gaps: Codex and Kimi devs still report to the lead over Herdr, and so does the stall watchdog. A plan to route every harness over the socket channel lives in the skill's `TODO.md`.

## When a dev says it is finished

A `DONE` alert, an idle status, or the word "done" is a **claim**, not a fact. Devs also finish silently, so "no message" does not mean "still working".

The lead verifies state rather than the story:

```bash
git merge-base --is-ancestor origin/<base> HEAD
git log --oneline origin/<base>..HEAD
git diff --stat origin/<base>...HEAD
```

It confirms the tree is clean, only expected areas changed, and the base branch was not pushed to. Then it re-runs the project's verify gates **once** through a cheap verifier that returns counts only — a mismatch with the dev's report is itself a finding.

## Review checklist

- Diff matches the task, no scope creep.
- Each acceptance criterion maps to a visible change or test.
- Tests exist and are non-tautological. Added columns mean grepping every allowlist, select, serializer, and modifier naming sibling columns; env or role guards mean enumerating every route including list endpoints; a new cache means asking where it's invalidated.
- Test, lint, and typecheck output **reported, not claimed**.
- No silent failures — empty catches, swallowed errors, or default values for required env vars.
- Commits follow `type(scope): summary`.

All findings go back in **one round** — each round costs 10–25 minutes.

## Handling a stuck dev

1. **Read the attempts.** Half the time it's a missing fact — an env var, the wrong command, an unread convention. Supply it and resend to the same dev.
2. **Capability problem** → escalate one tier (haiku → sonnet → opus) with the failed attempts in the brief, then retire the original dev.
3. **Design problem** → that's the lead's to decide, or yours if scope changes.

Never let a dev exceed 3 attempts, or the lead exceed 3 rounds of resend on one task.

## Operational limits

- **Machine load** — at most **2 heavy jobs** at a time across the whole team (a dev running tests, a verifier, a code review, a Playwright run), one verify run at a time. Only the lead sees all in-flight devs, so it owns how many app stacks run: often 1–2 on a laptop; beyond that, a PR that triggers the project's preview deployment replaces local runs.
- **Serialize with `flock`** when a task needs a multi-GB typecheck, a full production build, a browser e2e matrix, or ordered PR merges:

  ```bash
  flock /tmp/<project>-heavy.lock bun run mtc
  ```

- **Protect the lead's files** — the status table and briefs are the lead's memory. Agents get copies under `scratch/`.

## Status tracking

A markdown status table lives in your working notes (`notes/team-lead-<date>.md`, or `agent/reports/` outside a hyper space), updated on every state change, with columns `ref | title | model | state | worktree | notes` where state is one of todo, running, review, blocked, done.

## Bundled scripts

All live in the plugin and are invoked through the plugin root variable, never a hardcoded path.

### `check-deps.sh`

```
check-deps.sh [--config <harnesses.yaml>]
```

Checks the base CLIs, `herdr` when `HERDR_ENV=1`, every configured harness's CLI (`bin:` may explicitly name its executable), and `pi-claude-link` when pi is configured without `messaging: herdr`. Silent and exit 0 when all is present; otherwise one `MISSING <what> — <how to fix>` line each and exit 1.

### `rebase-worktrees.sh`

Rebases every local worktree with an open PR onto a rewritten base — the recovery path after a hotfix forces history. Policy is **no merge commits, ever**.

```
rebase-worktrees.sh --base <branch> [--space <path>] [--dry-run]
                    [--only <branch,...>] [--push] [--all-authors]
```

By default it only touches PRs authored by the current `gh` user. Per-worktree outcomes are `OK`, `PUSHED`, `SKIPPED-dirty`, `SKIPPED-no-worktree`, or `CONFLICT` (left mid-rebase, deliberately not aborted).

### `team-status.sh`

A one-shot status snapshot. **Requires `herdr`** — it looks each ref up as a Herdr agent — so automated monitoring is available only in Herdr mode.

```
team-status.sh --table <path> --prefix <project>- [--budgets <path>]
               [--reports <dir>] [--alerts-only] [--state <file>] [--json]
```

It parses task refs from the first column of your status table and emits lines only for `OVER-BUDGET`, `BLOCKED`, `DONE`, `MISSING`, `LOAD`, and `HEAVY`. With `--state`, each alert fires once and emits `CLEARED` when it stops.

The lead wraps this in a single monitor loop running about every 3 minutes, armed the moment the first dev launches — it's the backstop that catches a dev finishing without messaging.

### `stall-watch.sh`

A token-free watchdog the lead starts once per session as a background shell. When nobody on a team has been working for `--quiet-min` minutes, it prompts the team's leader with each member's status; if the team stays quiet, it escalates once. `--snooze <leader> <minutes>` silences it while a team is legitimately waiting. Unnamed Herdr leaders use the live pane ID from `herdr pane current --current | jq -r .result.pane.pane_id` (not the possibly stale `$HERDR_PANE_ID`).

```
stall-watch.sh --team <leader-name-or-pane-id>='<project>-<glob>' [--team ...] --escalate <agent-name-or-pane-id> --quiet-min 15
```

## Red flags

If any of these happen, the lead is off-pattern and should re-read the skill:

- Editing feature code itself.
- Running `rg`, `cat`, or `git log` instead of sending it to a cheap agent.
- A dev on attempt 4 or beyond.
- Spawning the top tier for a task the default tier hasn't failed at.
- Tailing a dev's output in a loop.
- A brief containing the lead's hypothesis instead of facts.
- A stale status table.
- Briefing a task whose acceptance criteria were inferred rather than read.

## See also

- [Decompose](/docs/decompose) — the problem-reduction loop the lead applies to individual hard tasks.
- [Plugin overview](/docs/) — the rest of the marketplace.
