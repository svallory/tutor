---
name: obscura
description: Use when a task needs a headless browser and Obscura (the `obscura` CLI) is the engine — fetching or scraping JavaScript-rendered pages from the command line, turning a page into markdown, running Playwright scripts or Playwright Test E2E suites against `obscura serve` instead of bundled Chromium, or watching a headless session live in a browser tab. Triggers on "obscura", "obscura serve", "obscura fetch", "obscura scrape", "connectOverCDP", "run the e2e on obscura", "headless browser without Chrome", "watch the headless session".
---

# Obscura

Obscura is a headless browser written in Rust: it runs real JavaScript on V8, speaks the Chrome DevTools Protocol, and ships as one small binary. It is **not Chromium**. Most pages and most Playwright calls work; some do not, and which ones changes between releases. This skill tells you how to drive it and how to find out what works on the installed version instead of guessing.

## Installed version

!`obscura --version 2>&1 || echo "OBSCURA: NOT INSTALLED"`

If the line above says `OBSCURA: NOT INSTALLED`, run the [dependency check](#dependency-check) and stop there.

Every fact in this skill was measured on **obscura 0.2.3 with Playwright 1.63.0 (macOS arm64, 2026-10-01)**. On any other version, the binary's own `--help` and the [probe](#find-out-what-works-the-probe) win over this text; say so when they disagree.

## Dependency check

Once per session, before the first command, with the flags of the workflow you are about to run:

```bash
$CLAUDE_PLUGIN_ROOT/skills/obscura/scripts/check-deps.sh [--scrape] [--render] [--serve] [--playwright <project-dir>]
```

`--scrape` for `obscura scrape`, `--render` for screenshots, PDF and the live view, `--serve` plus `--playwright <dir>` for anything that connects Playwright. It prints nothing and exits 0 when everything is present; otherwise one `MISSING <what> — <how to fix>` line each.

If anything is missing, **stop and tell the user what and how to fix it**. Do not install Obscura or a Playwright package yourself without asking, and do not quietly run the task on bundled Chromium instead: the user asked for Obscura, and a run on a different engine answers a different question.

## Pick the mode

| The task | Use |
|---|---|
| Read one page: text, markdown, links, a value, a screenshot | `obscura fetch` |
| The same expression over many URLs | `obscura scrape` (one worker pool; never a shell loop of `fetch`) |
| Several steps on one page, a login, an E2E test | `obscura serve` + Playwright |
| The user wants browser tools inside their agent, not a script | `obscura mcp` is the user's own setup step; see `references/cli.md` |

## One page or many: fetch and scrape

```bash
obscura fetch <url> --quiet --dump markdown                    # whole page as LLM-ready markdown
obscura fetch <url> --quiet --eval "document.title"            # one value
obscura fetch <url> --quiet --screenshot page.png              # needs a render build
obscura scrape <url>... --quiet --eval "document.title"        # JSON: a `results` array, one entry per URL
```

The result goes to stdout and progress lines to stderr; `--quiet` drops the progress lines.

Behaviors that are easy to get wrong (all measured, see the version above; several differ from Obscura's own docs):

- **A failed `--eval` looks like a null result.** `--eval` takes one expression. An expression that throws, or several statements (`var a = 1; a + 1`), prints `null` and exits 0, the same as a real `null` or `undefined`. A surprising `null` means "check the expression", not "the page has no value". Wrap statements in an IIFE: `(() => { …; return x; })()`.
- **`--eval` does not await.** A promise prints `{}`. Read values that are already on the page; for anything asynchronous use Playwright.
- **`--eval` output is not uniform JSON.** Strings print unquoted (`Example Domain`), numbers as floats (`1+1` prints `2.0`), objects and arrays as JSON. Return an object when you need to parse the result.
- **`--selector` waits, it does not narrow.** It waits up to 5 s for the selector, warns on stderr if it never appears, and dumps the whole page either way with exit 0. To read one region, use `--eval "document.querySelector('main').innerText"`.
- **Exit 0 does not mean the page is the one you wanted.** An HTTP 404 exits 0 with the error page's content; only a failed navigation (DNS, refused, blocked) exits 1. In `scrape`, a failed URL is an entry with an `error` field, not a non-zero exit: check every entry.
- **`obscura scrape -` does not read stdin**; `-` is taken as a URL and fails. Pass the URLs as arguments.
- **`--wait-until` accepts any string without an error.** The values that mean something are `domcontentloaded`, `load`, `networkidle2`, `networkidle0`. Playwright's `networkidle` is not one of them on the CLI.
- **localhost and private addresses are blocked by default** (`Access to private/internal IP address … is not allowed`). Add `--allow-private-network` for a dev server; leave it off for anything that takes URLs from outside, since the block is the SSRF guard.

Flags, `--dump` formats, stealth, proxies and persistent sessions: `references/cli.md`.

## Playwright on Obscura

Run the command through the wrapper. It starts `obscura serve` on a free port, waits until it answers, sets `OBSCURA_CDP_URL` for the command, and stops the server when the command ends, however it ends:

```bash
$CLAUDE_PLUGIN_ROOT/skills/obscura/scripts/with-obscura.sh --allow-private-network -- <command>
```

Flags before `--` go to `obscura serve`. `--allow-private-network` is needed whenever the pages under test are on localhost; drop it for public sites. The port is the first free one from 9222 to 9241; pass `--port <n>` to pin it, in which case a taken port is an error rather than a reason to move on.

**Connect with `chromium.connectOverCDP(process.env.OBSCURA_CDP_URL)`.** Never `chromium.connect()` and never Playwright Test's `use.connectOptions.wsEndpoint`: both speak Playwright's own protocol, which Obscura does not implement. They fail with a bare connect timeout, or hang with no error when no connect timeout is set, and either way it looks like a dead server.

For a **Playwright Test** suite, the project needs a fixture that swaps the browser. Ask the user before adding files to their project, then copy `obscura.ts` and `live-view.ts` from `$CLAUDE_PLUGIN_ROOT/skills/obscura/templates/` into the test directory and import `test`/`expect` from `./obscura` in the specs that should run on Obscura. Without `OBSCURA_CDP_URL` in the environment that file exports the stock `test`, so the project's normal browser run is unchanged. Do not run `playwright install` for an Obscura run: the fixture never launches the bundled browser, so the download buys nothing.

What works, what breaks, and how to write around it (`page.route`, `waitForURL`, `addStyleTag`, storage state): `references/playwright.md`. Read it before writing or debugging a test on Obscura.

## Find out what works: the probe

```bash
cd <project-with-playwright>
$CLAUDE_PLUGIN_ROOT/skills/obscura/scripts/with-obscura.sh --allow-private-network -- node $CLAUDE_PLUGIN_ROOT/skills/obscura/scripts/probe.mjs
```

It prints one `OK <check>` or `FAIL <check> — <reason>` line per Playwright feature, measured on the installed obscura and the project's own Playwright (`bun` works in place of `node`). Run it when the installed version differs from the one above, and before telling the user a feature is or is not supported. It takes a few seconds.

## Watch a session live

A separate viewer process cannot watch another client's pages: Obscura keeps each CDP connection's pages private to that connection, so an outside viewer only ever sees its own blank page. (The script in Obscura's own "watch agent sessions live" guide has this problem on 0.2.3; the probe's last line reports whether that has changed.) The capture has to run inside the connection that drives the page, which is what the `live-view.ts` template does.

- **Playwright Test**: with the fixture installed, add `OBSCURA_LIVE_VIEW=<port>` and `--workers=1`, then open `http://localhost:<port>`. One worker, because each worker is its own process and they would fight over the port.
- **A plain script**: `await startLiveView(port)` once, `await watchPage(page)` for the page to show.

Run `check-deps.sh --render` first: the viewer shows screenshots, which a `-no-render` build cannot take. Tell the user the URL; the viewer captures nothing until a tab is open on it.

## When a test fails only on Obscura

Re-run the same test on the project's normal browser before touching anything. If it passes there, the failure is an engine gap, not a bug in the app or the test: report it with the probe's output, and do not edit the app, the test, or its assertions to make Obscura pass. Rendering differs from Chromium too (text wraps differently, some CSS is missing), so pixel baselines and visual-regression suites do not belong on Obscura.

## Red flags

- You are about to run `playwright install` for a run that connects to Obscura.
- A config has `connectOptions: { wsEndpoint }` pointing at Obscura, or code calls `chromium.connect()`.
- You started `obscura serve … &` by hand, or you are about to `pkill -f 'obscura serve'`. The first leaves a server behind; the second kills servers that are not yours. Use `with-obscura.sh`.
- A test failed on Obscura and you are changing the test or the app without having run it on Chromium.
- You are stating that a flag or a Playwright feature works from memory, on a version other than the one this skill was measured on.
- You are adding `--stealth` to get past a login wall, a paywall, a CAPTCHA or an active bot challenge. It does none of those (see `references/cli.md`), and getting past access controls is not what it is for.
- You are passing `--allow-private-network` to a command whose URLs come from user input or a crawl.
