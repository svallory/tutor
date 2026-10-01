# Tutor

Tutor your AI Agents to make them better.

A marketplace of plugins and skills that tutor AI agents.

## Installation

```
/plugin marketplace add svallory/tutor
```

## Available Plugins

| Plugin | Description |
|--------|-------------|
| **ghostwriter** | Adversarial AI text detection and humanization system. Detects AI-generated text and iteratively revises it to read as authentically human. |
| **decompose** | Structured problem decomposition for hard problems. Triggers when the answer isn't immediately known: define the gap, enumerate variables, decompose into testable hypotheses, test one variable at a time. |
| **team-lead** | Dev team leader: decomposes a batch of tasks, assigns them to developer agents at the cheapest adequate model, reviews their work, and tracks progress. |
| **demo-video** | Narrated, subtitled MP4 demos of web-app features: Playwright recording with animated cursor, ffmpeg assembly paced by TTS narration, title cards and outro. |
| **sync-skills** | One shared `~/.agents/skills` folder for Claude Code, Pi, Kimi, Codex and agy with no duplicate skill names: real per-config Claude skills folders with per-skill links, claude.ai-synced skills linked once. |
| **okf** | Create, validate, and enrich Open Knowledge Format (OKF) bundles — knowledge as markdown files with YAML frontmatter, incl. v0.2 provenance, trust, and Attested Computations. |
| **obscura** | Drive the Obscura headless browser: fetch and scrape JavaScript-rendered pages, run Playwright scripts and E2E suites against its CDP server without bundled Chromium, and watch the session live. |
| **hyper** | Hyper Coding workflow support: project spaces (a bare repo wrapping all of a project's worktrees), per-edit integration with a project's own linters/typecheckers, spec-driven planning, and template-driven generation. Sourced externally from [hyper-coding](https://github.com/svallory/hyper-coding). |

### Ghostwriter

```
/plugin install ghostwriter@tutor
```

Then run `/setup` to configure your author profile and first publication.

See [ghostwriter README](src/plugins/ghostwriter/README.md) for full documentation.

### Decompose

```
/plugin install decompose@tutor
```

Ask for "decompose" or "break this down" when facing a hard problem, bug with no obvious cause, or vague problem statement ("it's slow", "it doesn't work"). The skill turns problem-solving into a systematic 6-step loop: define the gap, enumerate variables, map relationships, decompose into testable subproblems, test one variable at a time, validate and iterate.

See [decompose README](src/plugins/decompose/README.md) for details.

### Team Lead

```
/plugin install team-lead@tutor
```

Hand it a batch of tasks ("team-lead this sprint", "assign these tickets to devs"). Requires `git`, `gh`, `jq`, and [worktrunk](https://github.com/max-sixty/worktrunk); Herdr integration is optional.

See [team-lead README](src/plugins/team-lead/README.md) for the full dependency table and workflow.

### Demo Video

```
/plugin install demo-video@tutor
```

Ask for a "demo video" or "feature walkthrough video" of a web-app feature. The skill installs the pipeline into the project on first use (`scripts/demo/`, `e2e/demo/`), writes `.claude/demo-video-skill.config.json`, then records, narrates and builds the MP4.

Requires ffmpeg, Playwright, and either `GEMINI_API_KEY` (gemini-tts) or the offline `qwen3-tts-mlx` engine.

See [demo-video README](src/plugins/demo-video/README.md) for config schema, commands, and troubleshooting.

### Sync Skills

```
/plugin install sync-skills@tutor
```

Ask to "sync skills" when agents report skill-name collisions or Claude doesn't see a skill you added to `~/.agents/skills`. See [sync-skills README](src/plugins/sync-skills/README.md).

### OKF

```
/plugin install okf@tutor
```

Teaches the agent the [Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format): create bundles, validate them (via [okflint](https://github.com/mattdav/okflint) or the bundled fallback script), enrich concepts with provenance and trust fields, migrate v0.1 → v0.2, and convert Notion/Obsidian/CSV sources.

See [okf README](src/plugins/okf/README.md) for contents and details.

### Obscura

```
/plugin install obscura@tutor
```

Ask to "fetch this page with obscura" or "run the e2e suite on obscura". Requires the [Obscura](https://github.com/h4ckf0r0day/obscura/releases) binary on `PATH`, plus a Playwright package in the project for E2E runs (no browser download). The skill's facts carry the versions they were measured on, and a bundled probe re-measures Playwright support on whatever is installed.

See [obscura README](src/plugins/obscura/README.md) for the scripts, the Playwright Test fixture, and the known gaps.

## Individual skills via the skills CLI

The standalone skills are also installable with the [skills CLI](https://skills.sh) (works with Claude Code, Codex, Cursor, and others):

```
npx skills add svallory/tutor
```

This lists `okf-open-knowledge-format`, `team-lead`, and `demo-video`. Ghostwriter's internal helper skills (`detector-red-flags`, `surgical-update`, `writer-examples`) are marked internal and hidden by default — they only make sense inside the ghostwriter plugin's agent pipeline.

The repo's [skills.sh](https://skills.sh/svallory/tutor) page layout is configured in [skills.sh.json](skills.sh.json).

## For maintainers

Repo layout:

```
src/plugins/<name>/         # canonical sources: plugin.yaml, content, *.jig templates, README
build/                      # compile.ts, templates/*.jig.edge
tutor.config.yaml           # single build config: marketplace, platforms, plugin/platform restrictions, skills
dist/<platform>/plugins/    # compiled per-platform plugins (committed, never hand-edited)
dist/kimi/marketplace.json  # Kimi catalog
dist/omni/skills/           # portable skills-only output for the skills.sh ecosystem
.claude-plugin/marketplace.json  # Claude catalog (must stay at the repo root), points at ./dist/claude/plugins/<name>
skills.sh.json               # generated from tutor.config.yaml's skills.groups
```

Everything under `dist/`, the root `.claude-plugin/marketplace.json`, and `skills.sh.json` is **compiled, not hand-edited**. Canonical sources:

- `src/plugins/<name>/plugin.yaml` — one per plugin (name, version, description, author, keywords, interface). A plugin's `skills/`, `agents/`, and `commands/` dirs are detected automatically.
- `tutor.config.yaml` — the single build input, with four sections:
  - `marketplace` — name/owner + externally sourced plugins (e.g. hyper)
  - `platforms` — one entry per build target: `claude`, `kimi`, and `omni`. Each carries `harness`, `configDir`, `pluginRootVar`, and an optional `models` tier map. Platforms with no `models` key (currently `omni`) drive templates down their `@if(platform.models) … @else … @end` generic branch.
  - `plugins.<name>.platforms` — optional array restricting which `dist/<platform>/plugins/<name>/` trees a plugin builds to. Absent means all platforms.
  - `skills.public` — skill names (the `name:` frontmatter in each `SKILL.md`, not the directory) that ship in `dist/omni/skills/` and in `skills.sh.json`. `skills.groups` — the grouped listing rendered verbatim into `skills.sh.json`'s `groupings`. A skill whose `SKILL.md` frontmatter sets `metadata.internal: true` must not appear in either list — the build fails naming it. A name in either list that no plugin's `skills/<dir>/SKILL.md` defines also fails the build.
- Any `*.jig` file inside a plugin — a [Jig](https://jig.saulo.engineer) template rendered per platform (`{{ platform.configDir }}`, `{{ platform.models.fast }}`, `@if(platform.models) …`) to its stripped name (`SKILL.md.jig` → `SKILL.md`). Only the `.jig` lives in `src/`; don't add the rendered sibling next to it (the build fails if you do).
- Manifest templates live in `build/templates/*.jig.edge` (Jig's disk loader requires the `.edge` extension).

After changing any of these:

```
bun install     # first time
bun run build
```

The build wipes and regenerates each `dist/<platform>/` (every id under `tutor.config.yaml`'s `platforms:`) from scratch, so deleted or renamed source files never leave stale outputs behind. For `claude` and `kimi` it writes `dist/<platform>/plugins/<name>/` (all content copied verbatim except `plugin.yaml`, `*.jig` rendered) plus the platform manifest:

- Claude: `dist/claude/plugins/<name>/.claude-plugin/plugin.json`, and the root `.claude-plugin/marketplace.json`
- Kimi: `dist/kimi/plugins/<name>/kimi.plugin.json`, and `dist/kimi/marketplace.json`

`omni` is skill-scoped, not plugin-scoped: it has no manifest and no catalog. It writes only `dist/omni/skills/<skill-name>/` for each name in `skills.public`, copied from that skill's source dir and rendered with the `omni` platform's vars. A plugin like ghostwriter, restricted to `platforms: [claude, kimi]`, never appears under `dist/omni/` even if it defines skills, because its skills aren't in `skills.public`.

Commit the regenerated `dist/`, `.claude-plugin/marketplace.json`, and `skills.sh.json` together with the source change. CI runs `bun run build:check`, which renders in memory and fails naming every generated file that is missing, outdated, has the wrong executable bit, should no longer exist, or (for a whole `dist/<id>/` tree with no matching `platforms:` entry) is orphaned.
