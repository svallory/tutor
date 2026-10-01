# Obscura

Drive the [Obscura](https://github.com/h4ckf0r0day/obscura) headless browser from your agent: read JavaScript-rendered pages from the command line, run Playwright scripts and E2E suites against it instead of bundled Chromium, and watch the headless session live in a browser tab.

Obscura is a small Rust browser that speaks the Chrome DevTools Protocol. It is not Chromium, and what it supports changes from release to release. The skill treats that as the main fact: everything it states carries the versions it was measured on, and it ships a probe that re-measures on whatever you have installed.

## Install

```
/plugin marketplace add svallory/tutor
/plugin install obscura@tutor
```

Or as a standalone skill via the [skills CLI](https://skills.sh):

```
npx skills add svallory/tutor --skill obscura
```

You also need Obscura itself, from its [releases page](https://github.com/h4ckf0r0day/obscura/releases). Keep `obscura` and `obscura-worker` in the same directory on your `PATH`.

## Requirements

| Dependency | Required for |
|---|---|
| `obscura` on `PATH` | everything |
| `obscura-worker` beside it | `obscura scrape` |
| a render-enabled build (archive name without `-no-render`) | screenshots, PDF, the live view |
| `curl` | starting a server through the wrapper script |
| a Playwright package in your project | Playwright runs. `playwright-core` is enough, and no browser download is needed |
| `node` or `bun` | the feature probe |

The skill checks these in one call before it starts and tells you what is missing. It does not install Obscura or Playwright for you, and it does not fall back to bundled Chromium without saying so.

## When it triggers

- You name it: "fetch this with obscura", "scrape these URLs with obscura", "run the e2e suite on obscura".
- You ask for a headless browser without Chrome, or mention `obscura serve`, `obscura fetch` or `connectOverCDP`.
- You want to watch what a headless session is doing.

## What the agent does

| You want | It uses |
|---|---|
| One page as text, markdown, links, a value or a screenshot | `obscura fetch` |
| The same expression over many URLs | `obscura scrape` |
| A multi-step flow, a login, an E2E suite | `obscura serve` with Playwright |

For Playwright, it runs your command through a wrapper that starts a server on a free port, sets `OBSCURA_CDP_URL`, and stops the server when the command ends, including on Ctrl-C. It never leaves a server behind and never kills one it did not start.

## Playwright Test on Obscura

The setting most guides suggest, `use.connectOptions.wsEndpoint`, does not work: it speaks Playwright's own protocol, which Obscura does not implement, and the run fails with a connect timeout. The skill instead adds a small fixture file to your test directory (it asks first). Specs import `test` and `expect` from it:

```ts
import { test, expect } from "./obscura";
```

With `OBSCURA_CDP_URL` unset, that file exports the stock `test`, so your normal browser run is unchanged. With it set, tests run on Obscura and bundled Chromium is never launched, so `playwright install` is not needed for these runs.

## Watching a session

Set `OBSCURA_LIVE_VIEW=8080`, run with `--workers=1`, and open `http://localhost:8080`. The page under test appears there, refreshed twice a second.

The viewer runs inside the test process on purpose. Obscura keeps each connection's pages private, so a separate viewer process, including the one in Obscura's own guide, shows only a blank page of its own.

## Known gaps

Measured on obscura 0.2.3 with Playwright 1.63.0:

- **Request interception** (`page.route`, `context.route`): once a route is registered, locator actions time out and in-page `fetch()` breaks. Mock at the server instead, or keep those specs on your normal browser.
- **`page.waitForURL()`** hangs after a client-side route change. `expect(page).toHaveURL()` works.
- **`page.addStyleTag()`** throws. Inserting a `<style>` element with `page.evaluate()` works.
- **localStorage** is not restored by `newContext({ storageState })` and is not persisted by `--storage-dir`. Cookies are.
- **Rendering** differs from Chromium, so pixel baselines do not transfer.

On the command line: `obscura fetch --selector` waits for an element but does not narrow the output, a failing `--eval` prints `null` with exit status 0, and `obscura scrape -` does not read stdin.

To see where your versions stand:

```bash
with-obscura.sh --allow-private-network -- node probe.mjs
```

It prints one `OK` or `FAIL` line per feature in a few seconds.

## When a test fails only on Obscura

The agent re-runs it on your normal browser first. If it passes there, the failure is an engine gap: the agent reports it with the probe output and leaves your test and your app alone.

## Credits

Started from [FelipeOFF/obscura-skill](https://github.com/FelipeOFF/obscura-skill) and Obscura's own [documentation](https://docs.obscura.sh). Every command and limit here was re-measured against the binary; where the result differed from those sources, the measurement is what this skill states.

## See also

- [Demo Video](/docs/demo-video) — records narrated walkthroughs with Playwright.
- [Plugin overview](/docs/) — the rest of the marketplace.
