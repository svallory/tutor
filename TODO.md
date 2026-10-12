# TODO

## Make the models chain in harnesses.yml automatically improve based on real experience

**Problem.** The role chains in `~/.config/hyper/team-lead/harnesses.yaml` (seeded from
`src/plugins/team-lead/skills/team-lead/default-models.yaml`) are curated by hand and go stale.
In the mash research run of 2026-10-01, the first two researcher entries were dead (402, 429),
`gpt-6.1-sol` was out of quota from the first request, five parallel `k3` agents used up the
5-hour window in about 30 minutes, and 89% of the work ran on a failover model the lead had not
chosen. The lead reported the wrong models for about 90 minutes. Evidence and numbers:
`agent/reports/model-performance-mash-research-2026-10-01.md`.

**What "improve from experience" needs.**

1. **Record what ran.** After each agent finishes, read the model per message from the harness's
   session log (pi: `~/.pi/agent-roles/<role>/sessions/<cwd>/*.jsonl`, fields `provider`, `model`,
   `stopReason`, `errorMessage`, `usage`) and show the real model in the status table.
2. **Keep a ledger.** One line per (role, harness:model, run): turns, quota and transient errors,
   latency per turn, tool-error rate, cost, and the review outcome per round (verdict, sampled
   citation accuracy, fabrication count).
3. **Feed the chain from the ledger.**
   - A quota error at launch demotes the entry until its window resets (5 hours for Kimi, the
     plan's window for others).
   - Notes in the file are rewritten from measurements (the "19 min/prompt" note on
     `space-bunny-free` was off by two orders of magnitude).
   - Reordering by measured quality is proposed to the operator with the evidence, not applied
     silently.
4. **One failover definition.** The per-role `pinball.json` and the `routing:` block list
   different orders today. Generate one from the other.
5. **Guard rails.** A cap on parallel agents per quota-limited model, and a check after launch
   that the model running is the model requested.

**Open questions.** Where the ledger lives (per space or global), how many runs before a
reordering is proposed, and how to score roles that have no reviewer (mechanic, developer).

## Protect the lead's inbox log from being truncated by a dev

**Problem.** On 2026-10-08 00:45 a dev on one team wrote its status to the
lead's inbox log (`scratch/reports/inbox-<lead>.log`) with `>` instead of
`>>`, and 448 lines of history became 33. The team-lead skill's reporting
convention relies on every agent appending one line to a shared file, and
nothing enforces append-only. The same can happen to `outbox-<lead>.log` on a
remote dev host, or to any shared status file a brief names.

**What to do.** Pick one, or layer them:

1. **Stop sharing a writable file.** The team-lead skill (and its pi
   counterpart) ships a tiny `report` helper (`hyper report <lead> "<line>"`)
   that appends under `flock` and refuses any other write; briefs name the
   helper, never the file.
2. **Make the file append-only at the OS level.** `chflags uappend` on macOS,
   `chattr +a` on Linux, set by the lead when it opens the inbox; an agent's
   `>` then fails loudly instead of truncating.
3. **A PreToolUse hook** in the team-lead plugin that rejects a Bash command
   containing `> <inbox path>` (single `>` or `tee` without `-a`) for any
   path matching `inbox-*.log` or `outbox-*.log`.
4. **Recovery.** The lead's skill tells it to snapshot the inbox to
   `.remember/` hourly (or on every read), so a truncation costs at most the
   last hour.

Evidence: the affected space's `.remember/now.md` logged the incident at 01:05
on 2026-10-08 (inbox truncated to 33 lines).
