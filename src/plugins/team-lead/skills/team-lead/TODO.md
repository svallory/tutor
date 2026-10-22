# team-lead TODO

## Harness-independent agent messaging

**Problem.** `herdr agent prompt` types messages into the receiver's terminal, so a message can collide with the operator typing in that pane. `SendMessage` and [pi-claude-link](https://github.com/alonw0/pi-claude-link) avoid the terminal but only cover Claude Code and pi, rely on Claude Code's private cross-session protocol, and pass every message through the `crossSessionInbound` approval gate. Codex and Kimi devs, and `scripts/stall-watch.sh` (its `deliver()` uses `herdr agent prompt`), still type into the lead's pane.

**Plan (supersedes the earlier `agent-link` CLI idea).** This is being solved outside this skill, as part of Hyper:

- **hyper-compat**: give every harness Claude Code's hooks contract, including `asyncRewake` (a background hook that wakes an idle session). Hook-only harnesses without a background mode fall back to a constant doorbell line typed only when the agent is idle. Phase 0 is proven (2026-10-01) and needs no new code for the harnesses this skill uses most:
  - Claude Code: native.
  - pi: [`pi-code`](https://github.com/ilovepixelart/pi-code) filtered to its hooks extension (`extensions/hooks/index.ts`). Tested alongside a full set of pi packages (pinball, pi-claude-link, pi-ask-user, …): idle wake 10/10, busy delivery exactly once.
  - Codex: launched attached to `codex app-server` (`codex --remote`) and reached with `codex queue --remote`; plain Codex TUIs keep the doorbell.
  - OpenCode and Amp: adapters only if they join the roster.
  - Design constraint for hyper-msg: the wake only works while a Stop hook is pending, so the hook's timeout must cover the longest expected idle gap (or the watcher re-arms it).
- **hyper-msg**: a durable per-agent inbox (Maildir-style JSON message files) plus a small command (`send`, `ack`, `watch`, `hook`). Messages reach agents through the hooks above, without typing and without the agent checking.

**When it lands, update this skill:**

1. Replace the "Agent messaging" table in SKILL.md with `hyper-msg send` for every pair; keep `herdr agent send-keys esc` for interrupts only.
2. Brief step 12 (completion signal) and the chain-of-command questions use `hyper-msg`.
3. Switch `scripts/stall-watch.sh` alerts to `hyper-msg send`.
4. Add `hyper-msg` and, for pi, the filtered `pi-code` package to `scripts/check-deps.sh`; launch Codex devs attached to an app-server.
5. Drop the pi-claude-link dependency and the `crossSessionInbound: "hold"` limitation note.

## Orca mode follow-ups

Added 2026-10-07 with the first Orca mode (see `agent/reports/2026-10-07-team-lead-orca-mode.md` in the repo).

1. **Token-free Orca watchdog.** `stall-watch.sh` is Herdr only. Write the Orca equivalent around `orca orchestration check --wait` plus `worker-list` liveness (`attention.requiresAction`, `nextAction.kind`), prompting the lead through `orca orchestration send` only when something needs action.
2. **Verify the untested paths**: `worker-start --agent claude|codex` fallback, the `worker_done` round trip through `check --wait --ack`, `worker-release` and `worker-abandon`. None ran end to end because pi on the remote test machine had no model quota.
3. **Run `team-status.sh --orca` against a live Run** with workers in every state (running, idle, done, blocked). It was only exercised against a Run whose dispatches were all failed or stopped (status `unverifiable`).
4. **Calibrate `ncpu / 2`.** Record observed per-dev load on each machine and revise the slot formula with data.
5. **`terminal wait --for exit` on remote handles** returned `timeout` even after the command finished; the probe polls `terminal read` for a `PROBE-END` marker instead. Re-check on a newer Orca and drop the polling if `wait` works.
6. **Heavy-process count** uses the same regex on every machine (`vitest|karma|ng build|tsc |turbo|jest|playwright|headless`); `headless` matches browser helper processes on a Mac, so `HEAVY local` fires at idle. Tighten the pattern or exclude browser helpers.
