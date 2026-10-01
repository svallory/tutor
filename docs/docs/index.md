# Docs

Tutor is a plugin marketplace for coding agents. Each plugin teaches your agent a workflow it doesn't have out of the box — humanizing AI text, orchestrating a batch of dev tasks, producing demo videos, structuring knowledge, or breaking down hard problems.

## Install the marketplace

```
/plugin marketplace add svallory/tutor
```

Then install any plugin by name:

```
/plugin install <name>@tutor
```

## Plugins

| Plugin | What it does | Needs |
|--------|--------------|-------|
| [Ghostwriter](/docs/ghostwriter) | Adversarial detection and humanization loop that revises AI-sounding text until it reads as human. | bun; Python 3.8+ optional |
| [Team Lead](/docs/team-lead) | Decomposes a batch of tasks, spawns developer agents at the cheapest adequate model, reviews their work. | git, gh, jq, worktrunk |
| [Demo Video](/docs/demo-video) | Narrated, subtitled MP4 demos of web-app features via Playwright and ffmpeg. | ffmpeg, Playwright, a TTS engine |
| [OKF](/docs/okf) | Create, validate, and enrich Open Knowledge Format bundles. | none |
| [Decompose](/docs/decompose) | Turns vague problems into ordered, testable hypotheses. | none |
| [Obscura](/docs/obscura) | Scrapes JavaScript-rendered pages and runs Playwright on the Obscura headless browser, with a live view. | obscura; Playwright for E2E runs |

A seventh plugin, **hyper**, ships in the catalog but is sourced from the separate [hyper-coding](https://github.com/svallory/hyper-coding) repository.

## Which one do I want?

- **Writing that sounds machine-generated** → [Ghostwriter](/docs/ghostwriter)
- **A sprint, board, or list of tickets to get through** → [Team Lead](/docs/team-lead)
- **A feature to show off in a video** → [Demo Video](/docs/demo-video)
- **Docs or knowledge an agent must read reliably** → [OKF](/docs/okf)
- **A bug or problem with no obvious cause** → [Decompose](/docs/decompose)
- **A page to scrape or an E2E run without Chromium** → [Obscura](/docs/obscura)

## Skills without the plugin

Several plugins are also published as standalone skills through the [skills CLI](https://skills.sh), which works with Claude Code, Codex, Cursor, and others:

```
npx skills add svallory/tutor
```

That lists the public skills — `okf-open-knowledge-format`, `team-lead`, `demo-video`, `decompose`, and `obscura`. Ghostwriter's helper skills stay internal to its own agent pipeline and are not published this way.

## Contributing

To add a plugin or skill of your own, see [Contribute](/contribute).
