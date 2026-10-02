# Playwright on Obscura

Measured on **obscura 0.2.3 with Playwright 1.63.0 (macOS arm64, 2026-10-01)**. Obscura changes quickly and several results below contradict its own documentation, so on any other version run `scripts/probe.mjs` (command in SKILL.md) and trust its output over this file.

## Contents

- [Connect](#connect)
- [Playwright Test: the fixture](#playwright-test-the-fixture)
- [What works](#what-works)
- [What breaks, and what to write instead](#what-breaks-and-what-to-write-instead)
- [Live view](#live-view)
- [Sessions and logins](#sessions-and-logins)
- [Troubleshooting](#troubleshooting)

## Connect

```js
import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP(process.env.OBSCURA_CDP_URL); // ws://127.0.0.1:<port>
const context = await browser.newContext();
const page = await context.newPage();
// …
await browser.close(); // closes the connection; the server keeps running
```

- `playwright-core` is enough. Nothing here downloads or launches a browser.
- `ws://127.0.0.1:<port>`, `http://127.0.0.1:<port>` and `ws://127.0.0.1:<port>/devtools/browser` all connect.
- `chromium.connect()` and Playwright Test's `use.connectOptions.wsEndpoint` do **not** work: they speak Playwright's own wire protocol. The symptom is `browserType.connect: Timeout … exceeded` when a connect timeout is set and an indefinite hang when it is not, with the server up and healthy.
- `browser.newContext()` gives an isolated context (separate localStorage and cookies). `browser.contexts()[0]` is the connection's default context.
- Each connection has its own pages and its own V8 isolates. Pages inside one connection share an isolate, so CPU-bound JavaScript on one page delays the others in that connection.

## Playwright Test: the fixture

`templates/obscura.ts` replaces the worker-scoped `browser` fixture with a `connectOverCDP` connection when `OBSCURA_CDP_URL` is set, and exports the stock `test` otherwise. `templates/live-view.ts` is the viewer it imports; the viewer only starts when `OBSCURA_LIVE_VIEW` is set, but the file has to be there. Copy both into the project's test directory (after asking), then in the specs that should run on Obscura:

```ts
import { test, expect } from "./obscura";
```

Run:

```bash
with-obscura.sh --allow-private-network -- <the project's playwright test command>
```

What this was measured to do:

- Without `OBSCURA_CDP_URL`, nothing changes: the project's own browser launches as before.
- With it, the bundled browser is never launched. The suite passes with no Chromium installed (`PLAYWRIGHT_BROWSERS_PATH` pointing at an empty directory), so `playwright install` is not needed.
- `page`, `context`, `baseURL`, `expect(page).toHaveURL()`, `expect(locator).toHaveText()` and failure screenshots work unchanged. Each test gets a fresh context.
- Several workers work: each worker opens its own connection (4 tests on 3 workers passed with `--fully-parallel`).
- `trace: "on"` wrote a `trace.zip` with screencast frames and `video: "on"` wrote a playable `video.webm`. Obscura's docs list both as unimplemented, so open the artifact once before relying on it.

The fixture swaps the browser and nothing else. `baseURL`, `webServer`, timeouts and reporters still come from the project's own Playwright config, so a new project needs `use.baseURL` before `page.goto("/")` works. A project that keeps its `webServer` block needs no extra step: Playwright starts the dev server, and `--allow-private-network` lets Obscura reach it.

## What works

Passed in the probe or in a test suite on the versions above:

- Navigation: `goto` (with `domcontentloaded`, `load`, `networkidle`, `commit`), link clicks, GET form submission, `goBack`, `reload`.
- Locators: `getByRole`, `getByLabel`, `getByText`, `locator(css)`; `fill`, `click`, `press`, `pressSequentially`, `textContent`, `inputValue`, `isVisible`, `waitFor`. Clicks are trusted events (`event.isTrusted === true`).
- Waiting: `waitForFunction`, `waitForLoadState`, `waitForResponse` for a request the page makes, `expect` polling assertions.
- Evaluation: `evaluate`, `addInitScript`, `addScriptTag`.
- Capture: `page.screenshot()` (viewport and `fullPage`), `setViewportSize`.
- State: `context.addCookies`, `context.cookies`, and `context.storageState()` (saves cookies and localStorage).

## What breaks, and what to write instead

| Call | What happens | Write instead |
|---|---|---|
| `page.route()` / `context.route()`, any pattern | Once a route is registered, locator actions on the page time out, an in-page `fetch()` or XHR throws `Execution context was destroyed`, and `page.title()` returns `Loading <url>` | Do not mock or block requests on Obscura. Mock at the server (a test API, a seeded database), or keep specs that need `route` on the project's normal browser |
| `page.waitForURL(url)` after a client-side route change | Hangs when the app calls `history.pushState` synchronously in the click handler (what most SPA routers do): the URL changes, the `load` event it waits for never comes | `await expect(page).toHaveURL(url)`, or `page.waitForURL(url, { waitUntil: "commit" })` |
| `page.addStyleTag()` | Throws `Execution context was destroyed` | `page.evaluate(() => { const s = document.createElement("style"); s.textContent = "…"; document.head.append(s); })` |
| `browser.newContext({ storageState })` | Cookies are restored; localStorage is empty | Seed localStorage with `addInitScript`, or log in through the UI in a `beforeEach` |
| `page.title()` while a route is registered | Returns `Loading <url>` | `page.evaluate(() => document.title)` (and see the first row) |

Also expect, per Obscura's docs: no service workers, no native media playback, incomplete long-tail CSS, raster-only PDF. Layout is close to Chromium's but not identical (a button label that fits on one line in Chrome wrapped in a test page here), so pixel comparisons do not transfer.

A failing check can leave a page stuck inside the server (the server log shows `Runtime.callFunctionOn exceeded 30000ms timeout`) and slow the calls that follow. That is one more reason to run each suite on its own throwaway server through `with-obscura.sh`.

## Live view

`templates/live-view.ts` serves a page on a local port that shows the watched page twice a second.

```ts
import { startLiveView, watchPage, stopLiveView } from "./live-view";

console.log(await startLiveView(8080)); // http://localhost:8080
await watchPage(page);                  // the most recently watched page wins
// … drive the page …
await stopLiveView();
```

With the fixture, `OBSCURA_LIVE_VIEW=8080` does the same for every test's page; add `--workers=1`. The port opens when the first test starts and closes with the run, and frames are captured only while a tab is connected, so open the tab as the run starts. A suite that finishes in a second or two can end before the first frame.

How it is built, and why:

- It captures through a second CDP session on the same page, inside the driving connection (`Page.captureScreenshot`), because no other connection can see that page. A standalone viewer process, including the one in Obscura's "watch agent sessions live" guide, shows only its own blank page on 0.2.3.
- It uses the CDP capture rather than `page.screenshot()`, which hides the caret and waits for fonts and so touches the page under test.
- It captures only while a browser tab is connected, and never keeps the test process alive.
- A capture that races a navigation fails once and recovers; ten failures in a row are reported on stderr.

## Sessions and logins

- Within one run, reuse a `context`.
- Across runs, start the server with `--storage-dir <dir>`: cookies persist across restarts. localStorage did not in this test (see `cli.md`), so a token kept in localStorage has to be re-seeded with `addInitScript`.
- One `--storage-dir` per identity, one server per directory.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `browserType.connect: Timeout` | `connect()` or `connectOptions.wsEndpoint` | `connectOverCDP` (the fixture does it) |
| `Access to private/internal IP address … is not allowed` | SSRF guard | start the server with `--allow-private-network` |
| `connectOverCDP: … ECONNREFUSED` | no server on that port | run through `with-obscura.sh`; check `OBSCURA_CDP_URL` |
| Locators time out on a page that looks fine | a `route` is registered | remove it (see the table above) |
| `waitForURL` hangs after a click | synchronous `pushState` | `expect(page).toHaveURL()` |
| Every call slows down after one failure | a stuck page in the server | restart the server; `with-obscura.sh` gives each run a fresh one |
| A heavy SPA never mounts | script budget exceeded | raise `OBSCURA_SCRIPT_DEADLINE_MS` / `OBSCURA_MODULE_BUDGET_MS` (`cli.md`) |
| A test fails here and passes on Chromium | engine gap | report it with the probe output; do not edit the test or the app |
