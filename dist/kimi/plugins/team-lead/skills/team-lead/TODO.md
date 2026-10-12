# team-lead TODO

## Harness-independent agent messaging

**Problem.** `herdr agent prompt` types messages into the receiver's terminal, so a message can collide with the operator typing in that pane. `SendMessage` and [pi-claude-link](https://github.com/alonw0/pi-claude-link) avoid the terminal but only cover Claude Code and pi, rely on Claude Code's private cross-session protocol, and pass every message through the `crossSessionInbound` approval gate. Codex and Kimi devs, and `scripts/stall-watch.sh` (`herdr agent prompt` at line 112), still type into the lead's pane.

**Plan (supersedes the earlier `agent-link` CLI idea).** This is being solved outside this skill, as part of Hyper:

- **hyper-compat**: small per-harness plugins that give every harness Claude Code's hooks contract, including `asyncRewake` (a background hook that wakes an idle session). Harnesses that already follow the contract need nothing; pi, OpenCode and Amp get an adapter; hook-only harnesses without a background mode fall back to a constant doorbell line typed only when the agent is idle.
- **hyper-msg**: a durable per-agent inbox (Maildir-style JSON message files) plus a small command (`send`, `ack`, `watch`, `hook`). Messages reach agents through the hooks above, without typing and without the agent checking.

**When it lands, update this skill:**

1. Replace the "Agent messaging" table in SKILL.md with `hyper-msg send` for every pair; keep `herdr agent send-keys esc` for interrupts only.
2. Brief step 12 (completion signal) and the chain-of-command questions use `hyper-msg`.
3. Switch `scripts/stall-watch.sh` alerts to `hyper-msg send`.
4. Add `hyper-msg` and the harness adapters to `scripts/check-deps.sh`.
5. Drop the pi-claude-link dependency and the `crossSessionInbound: "hold"` limitation note.

## Orca mode follow-ups

Added 2026-10-07 with the first Orca mode (see `agent/reports/2026-10-07-team-lead-orca-mode.md` in the repo).

1. **Token-free Orca watchdog.** `stall-watch.sh` is Herdr only. Write the Orca equivalent around `orca orchestration check --wait` plus `worker-list` liveness (`attention.requiresAction`, `nextAction.kind`), prompting the lead through `orca orchestration send` only when something needs action.
2. **Verify the untested paths**: `worker-start --agent claude|codex` fallback, the `worker_done` round trip through `check --wait --ack`, `worker-release` and `worker-abandon`. None ran end to end because pi on netcup had no model quota.
3. **Run `team-status.sh --orca` against a live Run** with workers in every state (running, idle, done, blocked). It was only exercised against a Run whose dispatches were all failed or stopped (status `unverifiable`).
4. **Calibrate `ncpu / 2`.** Record observed per-dev load on each machine and revise the slot formula with data.
5. **`terminal wait --for exit` on remote handles** returned `timeout` even after the command finished; the probe polls `terminal read` for a `PROBE-END` marker instead. Re-check on a newer Orca and drop the polling if `wait` works.
6. **Heavy-process count** uses the same regex on every machine (`vitest|karma|ng build|tsc |turbo|jest|playwright|headless`); `headless` matches browser helper processes on a Mac, so `HEAVY local` fires at idle. Tighten the pattern or exclude browser helpers.
