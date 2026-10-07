# Team Lead: Orca mode and multi-machine dispatch

Date: 2026-10-07. Work done autonomously while the operator slept. Every decision below is open for review; nothing was committed.

## Request

Make the `team-lead` skill work with Orca as well as Herdr, and let it distribute dev load across every machine connected through Orca (local Mac, netcup, any future environment).

## Decisions the operator made earlier (kept as given)

1. Mode detection: Orca mode when `ORCA_WORKSPACE_ID` is set, Herdr mode when `HERDR_ENV=1`, otherwise neither.
2. Capacity: live load only, no capacity config file.
3. Launch path: adopt the harness launch command from `harnesses.yaml` into an Orca terminal, then `worker-start --terminal`. Fall back to `worker-start --agent` only when adoption is impossible.
4. Repo missing on a remote machine: ask the operator first, then register with `orca project setup-clone` (or `setup-existing-folder` when the path exists). The machine is excluded until the repo is registered.

## Decisions made tonight

### Coordinator identity

The lead is assumed to run inside an Orca terminal, so `$ORCA_TERMINAL_HANDLE` is its coordinator handle. It is passed as `--from` to `run-create`, `worker-start` and `send`. Reason: without a sender terminal those commands fail with `no_active_sender_terminal`, and `worker-start` against a Run with no bound coordinator fails with `consumer_fenced`. If `ORCA_TERMINAL_HANDLE` is empty in Orca mode, the lead creates a terminal of its own titled `<project>-team-lead` and uses that handle for the rest of the session. The skill forbids using another pane's handle as `--from`.

`--from` is only accepted by `run-create`, `worker-start`, `send`, `ask`, `reply`. `worker-show`, `worker-list`, `worker-stop`, `worker-release` and `check` reject it (`invalid_argument`); `check` takes `--terminal <handle> --run <id>` instead. The skill states this to save the next lead the trial and error.

### One Run per batch

`orca orchestration run-create --title "<project> <date>" --from "$COORD" --json` once per batch. Each dev is one dispatch inside it. The Run id is recorded in the status table header so a lead resuming after compaction can find its workers with `worker-list --run`.

### Machine inventory and slot rules

- Inventory: local machine plus every environment from `orca environment list --json`. The list has no status field, so reachability is decided by the probe: a machine whose probe fails is excluded.
- Per-machine live probe, run right before each dispatch: local via `sysctl -n hw.ncpu` / `nproc` plus `uptime`; remote via a throwaway Orca terminal whose command prints `PROBE-BEGIN`, `nproc`, `uptime`, available memory, heavy-process count and `PROBE-END`. The lead polls `terminal read --environment <env>` until the end marker appears, then closes the terminal. Verified on netcup; details under "Verified facts".
- Slots: `max_devs = ncpu / 2` (integer division, minimum 1), `max_heavy = 2`, consistent with the existing local cap. A machine with `load1 > ncpu` or less than 2 GB available memory takes no new dev until the next probe says otherwise.
- Count against a machine only the devs this lead dispatched there (status table column `machine`). Other people's load shows up in the probe, which is the point of measuring live.
- Placement: least loaded machine (load1 / ncpu) with a free slot and the repo registered. Ties go to local, because the operator can watch a local terminal.
- The lead, merges, reviews and anything touching the operator's `gh` login stay local. Remote machines run devs only.

Reason for `ncpu / 2`: a dev agent plus its build/test commands averages about two cores at peak on the machines observed. It is a starting point; the skill tells the lead to record the actual observed load next to the budget calibration so the number can be revised with data.

### Repo registration on remotes

Before dispatching to a machine, `orca project setups --environment <env-id> --json` must list the project. If it does not, the lead asks the operator (through the chain of command) to confirm cloning and then runs `orca project setup-clone --project <id> --host runtime:<env-id> --path <abs> --json`, or `setup-existing-folder` when the operator names a path that already holds the repo. Verified on netcup with `setup-existing-folder` for `github:svallory/mxlang` at `/Users/svallory/work/mx-link`.

Worktrees: `wt` is required on each machine that will host devs, so the dependency check in Orca mode probes every candidate machine for `git`, `wt`, `jq`, `flock` and the harness CLI via the same throwaway terminal. A machine missing a tool is reported and excluded, not silently used.

### Launch and adopt

Per dev, on the chosen machine:

1. `orca terminal create [--environment <env-id>] --worktree path:<worktree> --title <project>-<ref> --command "<KEY=VALUE ...> <harness launch command> <question tool denied>" --json`. The `env:` block resolves to leading `KEY=VALUE` pairs on the command.
2. `orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 120000`.
3. `orca orchestration worker-start --spec "$(cat brief)" --task-title "<ref>: <title>" [--on <env-id>] --worktree path:<worktree> --terminal <handle> --run <run-id> --from "$COORD" --timeout-ms 90000 --json`. Exit 0 only when the worker is ready; the dispatch id goes into the status table.

Reasons: `worker-start --agent` knows only claude, codex, cursor, antigravity, muse, zcode, opencode and opencode2, so pi (the default dev harness) can only join through adoption. Adoption also keeps the account and config logic of `harnesses.yaml` unchanged. `--model`/`--effort` cannot be combined with `--terminal`, so the model is part of the launch command.

Verified end to end on netcup: a pi terminal was adopted, reached `state: ready, stage: input_accepted`, showed `liveness.verdict: live` in `worker-list --include-remote`, and was stopped with `worker-stop --dispatch`.

Fallback: if `worker-start --terminal` fails with "not running a recognized agent" for a harness Orca does not recognize, the lead falls back to `--agent claude` or `--agent codex` when the harness is one of those, otherwise it reports the harness as unusable in Orca mode. The `--agent` path was not exercised tonight.

### Brief delivery

In Orca mode the brief is the `--spec` of `worker-start`. Orca delivers it to the worker's terminal on `input_accepted`, so no `SendMessage`, `herdr agent prompt` or typed text is needed, and cross-session sockets are not required for remote devs. `SendMessage` still works lead to local Claude dev and is allowed for follow-ups to local devs; remote devs receive follow-ups via `orca orchestration send --from "$COORD" --type instruction --dispatch-id <id> --body ...`. Interrupting a dev is `orca terminal send --terminal <h> --text $'\e'` (escape) rather than `herdr agent send-keys esc`.

### Completion channel

Two signals, both required so one failing does not strand a dev:

- The worker contract: the brief tells the dev to run `orca orchestration send --from "$ORCA_TERMINAL_HANDLE" --type worker_done --subject "STATUS: DONE|BLOCKED|NEEDS-USER — <ref>" --task-id <id> --dispatch-id <id> --outcome succeeded|failed --report-path <report>` as its last action. The lead receives it with `orca orchestration check --terminal "$COORD" --run <run-id> --wait --types worker_done --ack`.
- The existing `STATUS:` first line of the report file, picked up by the status script.

Not verified end to end: pi on netcup had no working model (see below), so no worker ever sent `worker_done`. The `check --wait` command is documented in the orchestration guide and accepted the flags; only the message path remains untested.

### Monitoring

- `team-status.sh` gains an Orca backend: `--orca --run <run-id>` replaces `--prefix` lookups with `worker-list --run <id> --include-remote --limit 100 --json` joined with `task-list --run <id> --json` on the task id (worker-list carries no title), matched to refs where the task title is `<ref>` or starts with `<ref>:`. When a ref has several dispatches (retries), a live one wins, otherwise the last listed. Status mapping: `liveness.verdict live` means running (or idle when the activity is idle/waiting); `exited` means done when the outcome or dispatch status is `succeeded`, blocked when `failed`, stopped when stopped or cancelled, else `exited`; `unverifiable` is reported as `UNVERIFIABLE <ref>` and never as done; no matching worker is `missing`. The dispatch id is shown in the table's last column and in JSON `note`. Per-machine load lines `LOAD <machine> <load1>/<ncpu>` and `HEAVY <machine> <n> processes` come from probing each distinct machine in the table's `machine` column (header-detected; local inline, remote via the marker-polling probe). A machine that cannot be probed yields `PROBE-FAILED <machine>`. `--state` compares LOAD/HEAVY by keyword plus machine in Orca mode. JSON output adds `machines[]` (one per machine, with `probed`) and keeps the old `machine` object for the local host. The Herdr output format is unchanged.
- `stall-watch.sh` stays Herdr only. In Orca mode the equivalent is `check --wait` (blocks until mail arrives) plus the liveness verdicts in `worker-list`; a token-free Orca watchdog is listed in TODO.md rather than written tonight, because `worker-list` already carries `attention.requiresAction` and `nextAction.kind`, which the status script surfaces.

### Teardown

Per retired dev: `worker-stop --dispatch <id>` if still live, then `worker-release --dispatch <id>` to let Orca reclaim the terminal, then the existing checklist (containers, processes, secrets, worktree). On remote machines the worktree removal runs through a throwaway terminal with `wt remove`. `worker-abandon` only for a worker whose terminal is gone and that will not be retried.

### Recovery rules

- `liveness.verdict: unverifiable` authorizes inspection, never a stop or a retry. Read with `worker-read --dispatch <id>` first.
- A dispatch `failed` at stage `worktree_resolve` almost always means the terminal is not yet running a recognized agent: wait for `tui-idle` again and retry once.
- Never pass another pane's handle as `--from`; Orca binds the Run to that terminal and the real lead loses it (`consumer_fenced`).

### Dependency check

`check-deps.sh` in Orca mode resolves the Orca CLI in the order `ORCA_CLI_COMMAND`, `orca-dev`, `orca-ide` (Linux), `orca` (also probing `/Applications/Orca.app/Contents/Resources/bin/orca` on macOS), and runs `orca status`. `ORCA_WORKSPACE_ID` set but no Orca CLI is a contradiction, like the Herdr case. Both `ORCA_WORKSPACE_ID` and `HERDR_ENV=1` set at once is also reported: the lead must ask which mode to use. Remote-machine tool probes are the lead's job at inventory time, not this script's, because they need Orca terminals and a per-machine loop.

### Versioning and docs

`plugin.yaml` bumped to 0.6.0 (new mode is a feature). README, `docs/docs/team-lead.md` and the skill's TODO.md updated. Nothing committed; the repo is a GitButler workspace and the operator did not ask for a commit.

## Verified facts used

- Orca 1.4.222. Orchestration verbs live under `orca orchestration <verb>`; bare `orca worker-start` is "Unknown command".
- `terminal send` requires `--text ... --enter`; positional text is rejected.
- Headless remote terminals report `surface: background` with a warning that they could not be made discoverable. Harmless.
- Netcup environment id `bb87321e-0dd9-4a63-b63a-bdb66e1f630f`, 8 CPUs, 15 GB RAM, pi 1.0.4 and claude at `~/.local/bin`. During the test load1 was 11 to 15.8 from someone else's vitest processes, which is exactly what the live probe is for.
- `/usr/local/bin/orca` on this Mac is a stale symlink: it fails with "Unable to determine Orca.app path from symlink" (exit 1). `/Applications/Orca.app/Contents/Resources/bin/orca` works. Both `check-deps.sh` and `team-status.sh` therefore try candidates in the order `ORCA_CLI_COMMAND`, `orca-dev`, `orca-ide`, `orca`, app bundle, and keep the first whose `status` succeeds. Setting `ORCA_CLI_COMMAND=/Applications/Orca.app/Contents/Resources/bin/orca` (or fixing the symlink) is the operator fix; check-deps says so in its MISSING line.
- Remote `terminal create --environment <env>` requires `--worktree path:<p>` where `<p>` is a path registered on that environment (`orca project setups --environment <env> --json`, `.result.setups[].path`). Without `--worktree`: `invalid_argument "Remote terminal create requires --worktree because the client cwd cannot identify a server worktree."`; with an unregistered path such as `/tmp`: `selector_not_found`. The setups row for netcup shows `hostId: "local"`, which looks like an Orca display quirk; the environment filter is what matters.
- `terminal wait|read|close` on a remote handle must repeat `--environment <env>`; without it the local runtime answers `terminal_handle_stale` (the `_meta.runtimeId` in the reply differs). `terminal wait --environment <env> --for exit --timeout-ms 20000` still returned `timeout` after the probe command had finished, because the terminal's shell stays open; hence the marker polling. `terminal read --environment <env> --terminal <h> --json` returns `.result.terminal.tail[]` (source `stream`) containing the command echo, its output lines and the prompt.
- `worker-list --limit` accepts at most 100 (`Too big: expected number to be <=100`). `worker-list` has no task title; `task-list --run <id> --json` gives `.result.tasks[] | {id, run_id, task_title, display_name, spec, status, deps}` and `tasks[].id` equals `workers[].taskId`.
- `environment list --json` returns `.result.environments[] | {id, name, runtimeId, endpoints[]}` and no status field.
- This Claude session itself runs under Herdr (`HERDR_ENV=1` is in its environment), so every Orca-mode test had to be run with `HERDR_ENV=` cleared; the first test run showed the "both modes" contradiction alert for that reason, not because of a bug.

## Leftovers to clean or review

- Test Run `run_b14596fbdf5e` on the local Orca workspace with dispatches `ctx_f68a12aa1f20` (failed), `ctx_d1681df3c807` (failed) and `ctx_05fc9016f407` (stopped, terminal retained). Suggested: `orca orchestration worker-release --dispatch ctx_05fc9016f407`.
- Project setup `e422cdee-3d26-4f0a-a22d-5dac596b9b55` (mxlang at `/Users/svallory/work/mx-link`) remains registered on netcup. Keep or remove.
- Pi on netcup: the Kimi account hit its monthly usage limit and the fallback models returned "Model is unavailable". Operator-side quota problem, not a skill bug; remote pi devs will not work until a model with quota is configured there.

## Not verified

- `worker-start --agent claude|codex` fallback.
- `worker_done` round trip through `check --wait`.
- `worker-release` and `worker-abandon`.
- The new `team-status.sh --orca` backend against a live Run with workers in every state (tested only against the leftover Run above, which has no live workers; its failed dispatches read `unverifiable`, which is Orca's verdict, not the script's).
- The skill prose for Orca mode was not exercised by a real lead session end to end; the bash snippets in it were run piecewise against netcup, not as a whole.

## Files changed

All under `~/work/claude-plugins`, uncommitted (GitButler workspace; the operator did not ask for a commit):

- `src/plugins/team-lead/skills/team-lead/SKILL.md.jig`: launch-mode table and detection rule, Orca mode section (coordinator and Run, machine inventory and budgets with the probe snippet, repo registration, launch and adopt snippet, completion and follow-ups, stop/release/recover), Orca notes in the dev environment, workflow, brief, agent messaging, peer discovery, monitoring, stall watchdog, machine load, status table and red flags sections.
- `scripts/check-deps.sh`: Orca CLI resolution and `orca status` check; both-modes contradiction.
- `scripts/team-status.sh`: `--orca --run <id>` backend, `machine` column, per-machine probes and alerts, `UNVERIFIABLE` and `PROBE-FAILED` alerts, `machines[]` in JSON.
- `scripts/stall-watch.sh`: header note, Herdr only.
- `TODO.md` (skill): "Orca mode follow-ups" section, six items.
- `plugin.yaml`: version 0.6.0, description mentions Orca.
- `README.md`, `docs/docs/team-lead.md`: launch modes, Orca requirements row, Orca mode section, script docs.
- `dist/**` and `.claude-plugin/marketplace.json`: regenerated by the build.

## Build and verification results

- `bun run build`: 458 files written. `bun run build:check`: all generated files up to date. Built SKILL.md and team-status.sh contain the new probe recipe.
- `bash -n` passes on check-deps.sh, team-status.sh and stall-watch.sh.
- check-deps.sh: `HERDR_ENV= ORCA_WORKSPACE_ID=x` exits 0 with the working Orca binary; both variables set reports `MISSING a single launch mode` and exits 1; no reachable CLI reports `MISSING orca` and exits 1.
- team-status.sh `--orca --run run_b14596fbdf5e` with a two-row table (`adoption-test` on `netcup`, `nope-1` on local), run with `ORCA_CLI_COMMAND` pointing at the app bundle binary:
  - table output: `adoption-test unverifiable … netcup ctx_f68a12aa1f20`, `nope-1 missing … local`, then one `machine local:` and one `machine netcup:` line (netcup: load1 5.25, ncpu 8, available 6300 MB, 18 heavy processes).
  - `--alerts-only`: `UNVERIFIABLE adoption-test`, `MISSING nope-1`, `HEAVY local 20 processes`, `HEAVY netcup 19 processes`. A second run with the same `--state` file printed nothing (alerts matched by keyword plus machine). Exit 0 both times.
  - `--json`: `refs[]` with `machine` and `note`, `machine` (local), `machines[]` with `probed: true` for both, `alerts[]`.
  - No probe terminal was left open on netcup afterwards (`terminal list --environment` shows none titled probe).
- Known rough edge seen in the test: `HEAVY local 20 processes` fires on an idle Mac because the heavy regex's `headless` term matches browser helper processes. This predates tonight's work and is now TODO item 6.
