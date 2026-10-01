# Obscura CLI reference

Measured on **obscura 0.2.3 (macOS arm64, 2026-10-01)** unless a line says "upstream docs". `obscura <command> --help` on the installed binary wins over this file.

## Contents

- [Install](#install)
- [fetch](#fetch)
- [scrape](#scrape)
- [serve](#serve)
- [Global flags](#global-flags)
- [Sessions: `--storage-dir`](#sessions---storage-dir)
- [Stealth and proxies](#stealth-and-proxies)
- [MCP server](#mcp-server)
- [Environment variables](#environment-variables)

## Install

Releases: <https://github.com/h4ckf0r0day/obscura/releases>. One archive per platform (`obscura-aarch64-macos`, `obscura-x86_64-macos`, `obscura-x86_64-linux`, `obscura-aarch64-linux`, a Windows `.zip`), each holding two binaries that must stay in the same directory: `obscura` and `obscura-worker` (used by `scrape`).

The archive suffix is the feature set, and nothing in `obscura --version` repeats it, so note which one was installed:

| Suffix | Rendering (screenshots, PDF) | Stealth transport |
|---|---|---|
| none | yes | no |
| `-stealth` | yes | yes |
| `-no-render` | no | no |
| `-no-render-stealth` | no | yes |

Upstream docs: Linux builds need glibc 2.35+; on macOS a Gatekeeper warning clears with `xattr -d com.apple.quarantine ./obscura`; a Docker image exists (`h4ckf0r0day/obscura`).

Installing is the user's call. Give them the release URL and the archive name for their platform; do not download and install a binary for them unasked.

## fetch

`obscura fetch [OPTIONS] <URL>` loads one page and prints one thing.

| Flag | Default | Notes |
|---|---|---|
| `--dump <format>` | `html` | see the table below |
| `-e, --eval <JS>` | | one expression; see the caveats below |
| `--selector <CSS>` | | waits for the selector (up to 5 s); does **not** narrow the output |
| `--wait-until <level>` | `load` | `domcontentloaded`, `load`, `networkidle2`, `networkidle0`; any other string is accepted silently |
| `--wait <seconds>` | adaptive, 5 s cap | a fixed delay when given (`--wait 1` took 1.04 s) |
| `--timeout <seconds>` | `30` | navigation timeout |
| `-s, --screenshot <file>` | | PNG of the settled page; render build only; may be combined with `--eval`, which runs first |
| `-o, --output <file>` | | write the result to a file |
| `-q, --quiet` | | drop the progress lines on stderr |
| `--file <file>` | | batch mode: newline-delimited URLs, each fetched raw (`--dump original`), one JSON status line per URL; `-` for stdin (from `--help`, not measured) |
| `--user-agent <UA>` | a desktop Chrome UA | measured: sets `navigator.userAgent` |

`--dump` formats:

| Value | Output |
|---|---|
| `html` | rendered HTML of the whole document |
| `text` | visible text |
| `markdown` | markdown conversion; scripts and styles are left out |
| `links` | one `<url>\t<link text>` per line |
| `assets` | one JSON object per line, `{"url": …, "type": …}`, for every sub-resource |
| `original` | the raw HTTP response body, without running the page |
| `cookies` | the cookie jar as a JSON array, HttpOnly cookies included |

`--eval` caveats (each one measured):

- The result prints on stdout: strings unquoted, numbers as floats (`2.0`), `null`/`undefined` as `null`, objects and arrays as JSON.
- It is a single expression. Several statements, or an expression that throws, print `null` with exit 0.
- Promises are not awaited; a promise prints `{}`.

Exit status: 0 whenever the navigation completed, including an HTTP 404; 1 when it failed (DNS error, connection refused, blocked private address).

## scrape

`obscura scrape [OPTIONS] <URL>...` runs one expression on many pages through a worker pool. It needs `obscura-worker` beside `obscura`.

| Flag | Default |
|---|---|
| `-e, --eval <JS>` | |
| `--concurrency <n>` | `10` |
| `--format <format>` | `json` (also `text`) |
| `--timeout <seconds>` | `60` per URL |

`json` output is one object: `total_urls`, `concurrency`, timings, and `results`, an array of `{ url, title, eval, time_ms, worker }`. A URL that failed has `{ url, error, time_ms }` instead. `text` output is one `<time>\t<url>\t<value>` line per URL, strings JSON-quoted.

On 0.2.3 `obscura scrape -` does not read URLs from stdin (upstream docs say it does): `-` is treated as a URL and fails. Pass the URLs as arguments, e.g. `xargs obscura scrape --quiet --eval "document.title" < urls.txt`.

## serve

`obscura serve [OPTIONS]` runs the CDP server. Prefer `scripts/with-obscura.sh`, which starts and stops it around a command; start it by hand only for a server the user wants left running.

| Flag | Default | Notes |
|---|---|---|
| `-p, --port <port>` | `9222` | exits 1 with `Address already in use` when taken. Do not pass `0`: the banner then reports port 0, so the real port is unknown |
| `--host <host>` | `127.0.0.1` | a non-loopback bind is refused without `OBSCURA_CDP_TOKEN` (upstream docs) |
| `--workers <n>` | `1` | |
| `--max-connections <n>` | `128` | each connection has its own thread and V8 isolates; more are refused with 503 |
| `--allow-file-access` | off | lets CDP clients navigate to `file://` |
| `--font-dir <dir>` | | extra fonts for rendering; repeatable |
| `--quiet` | | |

Endpoints: `ws://127.0.0.1:<port>` (also `/devtools/browser`) for clients, and `http://127.0.0.1:<port>/json/version` as a readiness check. `/json/list` is a fixed placeholder (`page-1`, `about:blank`), not the list of open pages.

Each CDP connection sees only the pages it opened itself.

## Global flags

These work on every subcommand, before or after it:

| Flag | Notes |
|---|---|
| `--allow-private-network` | permit loopback, RFC 1918 and link-local targets; also `OBSCURA_ALLOW_PRIVATE_NETWORK=1`. Off by default as an SSRF guard |
| `--storage-dir <dir>` | persistent session; see below |
| `--stealth` | see below |
| `--proxy <url>` | HTTP or SOCKS5, credentials in the URL. `HTTP_PROXY`/`HTTPS_PROXY` are not honored (upstream docs) |
| `--user-agent <UA>` | |
| `--obey-robots` | respect robots.txt (fetch and scrape) |
| `--v8-flags <flags>` | raw V8 flags, applied at startup |
| `-v, --verbose` | info logging |

## Sessions: `--storage-dir`

`--storage-dir <dir>` writes `<dir>/cookies.json` and reloads it on the next run, for `fetch` and for `serve`. Measured: a cookie set in one run is present in the next, including across a server restart.

**localStorage did not persist** in the same test, on either `fetch` or `serve`, although upstream docs say it does. Do not build a "log in once, reuse the session" flow on localStorage tokens without running it twice and checking the second run.

For separate identities, use separate directories and separate `obscura serve` processes on different ports.

## Stealth and proxies

`--stealth` is accepted by every build without an error. The parts that matter (browser-matching TLS fingerprints, the tracker blocklist) exist only in a `-stealth` archive, and the CLI does not say which build it is.

Upstream docs on scope: it helps with detection that checks the TLS fingerprint or User-Agent. It does not solve Cloudflare interactive challenges, DataDome or Akamai active challenges, CAPTCHAs, or IP rate limits. Keep identity settings consistent with each other: `OBSCURA_TIMEZONE` (default `Europe/Berlin`), `OBSCURA_GEOLOCATION`, and the proxy's region.

Use it for automation the site permits. It is not a tool for getting past a login, a paywall, or a challenge, and a site's terms and robots.txt still apply (`--obey-robots`).

## MCP server

`obscura mcp` exposes browser tools (`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_screenshot`, …) over stdio, or over HTTP with `--http`. It is an alternative to this skill's CLI and Playwright routes, set up by the user in their own client, for example `claude mcp add obscura /path/to/obscura mcp`. Offer it when the user wants interactive browsing tools; do not add an MCP server to their configuration on your own. A non-loopback HTTP bind requires `OBSCURA_MCP_TOKEN` (upstream docs).

## Environment variables

From upstream docs; only `OBSCURA_ALLOW_PRIVATE_NETWORK` was measured here.

| Variable | Default | Effect |
|---|---|---|
| `OBSCURA_ALLOW_PRIVATE_NETWORK` | off | same as `--allow-private-network` |
| `OBSCURA_NAV_TIMEOUT_MS` | 30000 | ceiling for one navigation, redirects and script-driven hops included |
| `OBSCURA_SCRIPT_DEADLINE_MS` | 30000 | budget for a page's script phase; raise for a heavy SPA that mounts late |
| `OBSCURA_MODULE_BUDGET_MS` | 3000 | per-module budget on an already-rendered page; raise when a dev-server client (e.g. Vite HMR) is cut off |
| `OBSCURA_CDP_COMMAND_TIMEOUT_MS` | 60000 | per-CDP-command deadline; keep it above the navigation timeout |
| `OBSCURA_FETCH_TIMEOUT_MS` | 30000 | scripted `fetch()`/XHR and module loads |
| `OBSCURA_CDP_TOKEN` | | bearer token; required for a non-loopback `serve` bind |
| `OBSCURA_TIMEZONE`, `OBSCURA_GEOLOCATION`, `OBSCURA_PROFILE`, `OBSCURA_ROTATE_PROFILE` | | browser identity |
| `RUST_LOG` | | e.g. `obscura=debug`; logs go to stderr |

Full list: <https://docs.obscura.sh/reference/environment-variables>.
