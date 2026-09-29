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
