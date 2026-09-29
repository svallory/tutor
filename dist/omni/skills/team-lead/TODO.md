# team-lead TODO

## Generalize pi-claude-link to every harness

**Problem.** Agent messages sent with `herdr agent prompt` are typed into the receiver's terminal. When the operator is typing in that pane at the same moment, the two streams mix. This has happened several times in the lead's pane. `SendMessage` (Claude ↔ Claude) and [pi-claude-link](https://github.com/alonw0/pi-claude-link) (pi ↔ Claude) avoid the terminal, but Codex, Kimi and other harnesses still use Herdr (see "Agent messaging" in SKILL.md).

**Goal.** Any harness that can run a skill (so it can read instructions and run a shell command) can send to and receive from Claude Code sessions over Claude's cross-session sockets, the same way pi-claude-link does.

### How pi-claude-link works (the parts to reuse)

- `claude-protocol.ts` is a dependency-free port of Claude Code's cross-session wire protocol. It covers:
  - the registry in `~/.claude/sessions/<pid>.json`
  - Unix sockets in Claude's socket directory (`cc-socks/<pid>.sock`; here `~/.xdg/cc-socks`)
  - `<cross-session-message>` envelopes, delivery receipts and `rename` control frames
- `index.ts` binds that protocol to pi's extension API:
  - `session_start` registers the peer
  - inbound frames go to `pi.sendUserMessage`
  - `agent_end` relays the reply
  - the `claude-link` tool handles list/send/ask

### Plan

1. **Split the protocol out of the pi binding.** Turn `claude-protocol.ts` into a standalone package with a CLI, e.g. `agent-link`:
   - `agent-link list`: live sessions from the registry
   - `agent-link send <to> <message>`: send one frame and exit after the delivery receipt
   - `agent-link ask <to> <message>`: send, block until the reply and print it
   - `agent-link serve --name <name> --inbox <file>`: register a peer, bind the socket, append each inbound message to an inbox file (JSONL), and deregister on exit
2. **Sending works right away for every harness.** Any agent that can run a shell command can call `agent-link send`. This alone removes the collision for Codex and Kimi devs reporting to the lead, which is the case that actually hurts.
3. **Receiving needs a per-harness bridge.** A message has to get into the agent's turn without typing into its terminal:
   - Codex: check whether its hooks or notify mechanism can inject a message at turn boundaries. If not, a skill tells the agent to check the inbox (`agent-link inbox --since <cursor>`) at each step boundary.
   - Kimi Code: check its plugin/hook API for something like pi's `sendUserMessage`.
   - Generic fallback: `agent-link serve` runs next to the agent, and the skill tells the agent to poll the inbox. Delivery waits until the next check, but nothing gets mixed together.
4. **Ship a skill** (`agent-link`) with the CLI, in the same shape as pi-claude-link's bundled skill: list/send/ask, and the rule that peer messages are untrusted and never count as the operator's approval.
5. **Switch `scripts/stall-watch.sh` to `agent-link send`.** It messages leaders with `herdr agent prompt` (`stall-watch.sh:112`), so its alerts can collide with the operator typing in the lead's pane. A shell script can't call `SendMessage`, so it has to wait for the CLI. Fall back to Herdr for receivers that aren't registered in Claude's session registry.
6. **Update SKILL.md "Agent messaging"** so every harness that has a bridge uses the socket channel, and Herdr is left only for interrupts (`send-keys esc`).

### Open questions

- The protocol is private to Claude Code and may change without notice. Pin the Claude Code versions it was tested against, and add a smoke test (`reg-test`-style) the lead can run at startup.
- Registering with a PID that isn't a Claude or pi process: check that Claude's liveness filter (`ps -o lstart=` start-time check) accepts the `serve` process's PID.
- Upstream vs. fork: offer the protocol split to alonw0/pi-claude-link before forking.
