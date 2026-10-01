# Obscura plugin

Teaches an agent to use [Obscura](https://github.com/h4ckf0r0day/obscura), a headless browser written in Rust that speaks the Chrome DevTools Protocol, for three jobs: reading JavaScript-rendered pages from the command line, running Playwright against it instead of bundled Chromium, and watching a headless session in a browser tab.

Obscura is not Chromium, and what it supports changes between releases. The skill is built around that: its facts carry the versions they were measured on, and it ships a probe that re-measures them on whatever is installed.

## What it does

- **Picks the mode**: `obscura fetch` for one page, `obscura scrape` for many, `obscura serve` plus Playwright for multi-step flows and E2E suites.
- **Runs Playwright safely**: `with-obscura.sh` starts a server on a free port, hands its URL to your command, and stops it when the command ends, including on Ctrl-C.
- **Connects Playwright Test the way that works**: a fixture that uses `connectOverCDP`. The `connectOptions.wsEndpoint` setting other guides suggest times out against Obscura.
- **Shows the session live**: a viewer that captures from inside the driving connection. A separate viewer process cannot see another client's pages on Obscura.
- **Reports what is supported**: `probe.mjs` prints `OK`/`FAIL` per Playwright feature for the installed versions.

## Contents

```
skills/obscura/
├── SKILL.md                  # modes, rules, red flags
├── references/
│   ├── cli.md                # fetch / scrape / serve flags, output formats, sessions, stealth
│   └── playwright.md         # connecting, what works, what breaks and the replacement
├── scripts/
│   ├── check-deps.sh         # one-call dependency check
│   ├── with-obscura.sh       # run a command against a throwaway server
│   └── probe.mjs             # Playwright feature probe
└── templates/
    ├── obscura.ts            # Playwright Test fixture (opt-in through OBSCURA_CDP_URL)
    └── live-view.ts          # live viewer
```

## Requirements

Checked by `scripts/check-deps.sh`; the skill stops and reports what is missing instead of working around it.

| Dependency | Required for |
|---|---|
| `obscura` on `PATH` | everything |
| `obscura-worker` beside it | `obscura scrape` |
| a render-enabled build (no `-no-render` suffix) | screenshots, PDF, the live view |
| `curl` | `with-obscura.sh` |
| `@playwright/test`, `playwright` or `playwright-core` in the project | Playwright runs; no browser download needed |
| `node` or `bun` | `probe.mjs` |

Get Obscura from its [releases page](https://github.com/h4ckf0r0day/obscura/releases).

## Install

```
/plugin install obscura@tutor
```

Or via the [skills CLI](https://skills.sh):

```
npx skills add svallory/tutor --skill obscura
```

## Usage

Ask for it by name: "fetch this page with obscura", "run the e2e suite on obscura", "let me watch the headless session". Triggers on "obscura", "obscura serve", "connectOverCDP", "headless browser without Chrome".

By hand:

```bash
scripts/check-deps.sh --serve --render --playwright .
scripts/with-obscura.sh --allow-private-network -- npx playwright test
scripts/with-obscura.sh --allow-private-network -- node scripts/probe.mjs
```

## Credits

Started from [FelipeOFF/obscura-skill](https://github.com/FelipeOFF/obscura-skill) and Obscura's [documentation](https://docs.obscura.sh). Every command and limit was re-measured against the binary; where the result differed from those sources, the measurement is what the skill states.

## Verified on

obscura 0.2.3, Playwright 1.63.0, macOS arm64, 2026-10-01. Known gaps on those versions (request interception, `waitForURL` after a synchronous `pushState`, `addStyleTag`, localStorage restore and persistence) are listed with replacements in `references/playwright.md` and `references/cli.md`.
