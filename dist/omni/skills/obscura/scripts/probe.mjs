#!/usr/bin/env node
// probe.mjs — report which Playwright features work on the installed obscura.
//
// The tables in this skill are a snapshot of one obscura and one Playwright
// version. This prints the same facts for the versions actually installed, so
// a decision ("can this test mock a request?") rests on a measurement.
//
// Usage (from the project that has Playwright installed; node or bun):
//   with-obscura.sh --allow-private-network -- node probe.mjs
//
// Run it against a throwaway server, as above: a failing check can leave a
// page hanging inside the server it ran on.
//
// Output: one line per check, `OK <check>` or `FAIL <check> — <reason>`.
// Exit status: 0 when the probe ran (FAIL lines included), 1 when it could
// not run (no Playwright, no server, local pages blocked), 2 on a usage error.

import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

const cdpUrl = process.env.OBSCURA_CDP_URL;
if (!cdpUrl) {
  console.error("probe.mjs: OBSCURA_CDP_URL is not set; run it through with-obscura.sh");
  process.exit(2);
}

// resolve Playwright from the project in cwd, not from this script's directory
const projectRequire = createRequire(path.join(process.cwd(), "probe.cjs"));
let chromium;
let playwrightVersion;
for (const name of ["playwright-core", "playwright", "@playwright/test"]) {
  try {
    ({ chromium } = projectRequire(name));
    playwrightVersion = projectRequire(`${name}/package.json`).version;
    break;
  } catch {}
}
if (!chromium) {
  console.error(`probe.mjs: no Playwright package resolves from ${process.cwd()}`);
  process.exit(1);
}

const html = `<!doctype html><title>Probe</title><main><h1>Probe</h1><nav><a href="/next">Next page</a></nav>
<form><label for="e">Email</label><input id="e"><button>Go</button></form><p role="status"></p></main>
<script>document.querySelector("form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  document.querySelector("[role=status]").textContent = "hi " + document.getElementById("e").value;
  history.pushState({}, "", "/done");
});</script>`;
const next = `<!doctype html><title>Next</title><h1>Next</h1>`;
const site = http.createServer((req, res) => {
  if (req.url.startsWith("/api")) res.writeHead(200, { "Content-Type": "application/json" }).end('{"real":true}');
  else res.writeHead(200, { "Content-Type": "text/html" }).end(req.url === "/next" ? next : html);
});
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${site.address().port}`;

const T = { timeout: 4000 };
let browser;
try {
  browser = await chromium.connectOverCDP(cdpUrl, T);
} catch (err) {
  console.error(`probe.mjs: cannot connect to ${cdpUrl}: ${firstLine(err)}`);
  process.exit(1);
}
console.log(`obscura reports Chrome/${browser.version()}; Playwright ${playwrightVersion}`);

function firstLine(err) {
  return String(err?.message ?? err).split("\n")[0];
}

// each check gets its own context, so one broken page cannot fail the next
async function check(name, fn) {
  let context;
  try {
    context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(T.timeout);
    await fn(page, context);
    console.log(`OK   ${name}`);
    return true;
  } catch (err) {
    console.log(`FAIL ${name} — ${firstLine(err)}`);
    return false;
  } finally {
    await context?.close().catch(() => {});
  }
}
const expect = (cond, what) => {
  if (!cond) throw new Error(what);
};
const signIn = async (page) => {
  await page.getByLabel("Email").fill("a@b.co");
  await page.getByRole("button", { name: "Go" }).click();
  expect((await page.getByRole("status").textContent()) === "hi a@b.co", "status text did not update");
};

const reachable = await check("local pages (--allow-private-network)", async (page) => {
  await page.goto(origin);
  expect((await page.title()) === "Probe", "unexpected title");
});
if (!reachable) {
  console.error("probe.mjs: obscura cannot reach localhost; start it with --allow-private-network");
  await browser.close();
  site.close();
  process.exit(1);
}

await check("locators: fill, click, read text", async (page) => {
  await page.goto(origin);
  await signIn(page);
});
await check("link click navigates", async (page) => {
  await page.goto(origin);
  await page.getByRole("link", { name: "Next page" }).click();
  await page.getByRole("heading", { name: "Next" }).waitFor();
});
await check("page.url() follows a synchronous pushState", async (page) => {
  await page.goto(origin);
  await signIn(page);
  await page.waitForFunction(() => location.pathname === "/done");
  expect(page.url().endsWith("/done"), `page.url() is ${page.url()}`);
});
await check("waitForURL after a synchronous pushState", async (page) => {
  await page.goto(origin);
  await signIn(page);
  await page.waitForURL(/\/done$/);
});
await check("screenshot", async (page) => {
  await page.goto(origin);
  expect((await page.screenshot()).length > 1000, "empty screenshot");
});
await check("waitForResponse on an in-page fetch", async (page) => {
  await page.goto(origin);
  const [response] = await Promise.all([page.waitForResponse(/\/api/), page.evaluate(() => fetch("/api").then((r) => r.status))]);
  expect(response.status() === 200, "unexpected status");
});
await check("addScriptTag", async (page) => {
  await page.goto(origin);
  await page.addScriptTag({ content: "window.probe = 1" });
  expect((await page.evaluate(() => window.probe)) === 1, "script did not run");
});
await check("addStyleTag", async (page) => {
  await page.goto(origin);
  await page.addStyleTag({ content: "h1{color:rgb(255,0,0)}" });
});
await check("storageState saves cookies and localStorage", async (page, context) => {
  await page.goto(origin);
  await page.evaluate(() => localStorage.setItem("probe", "1"));
  await context.addCookies([{ name: "probe", value: "1", url: origin }]);
  const state = await context.storageState();
  expect(state.cookies.length > 0, "no cookies saved");
  expect(state.origins.length > 0, "no localStorage saved");
});
await check("newContext({ storageState }) restores localStorage", async (page, context) => {
  await page.goto(origin);
  await page.evaluate(() => localStorage.setItem("probe", "1"));
  const restored = await browser.newContext({ storageState: await context.storageState() });
  try {
    const second = await restored.newPage();
    await second.goto(origin);
    expect((await second.evaluate(() => localStorage.getItem("probe"))) === "1", "localStorage is empty in the restored context");
  } finally {
    await restored.close();
  }
});
await check("page.route: locators still work", async (page) => {
  await page.route("**/*.png", (route) => route.abort());
  await page.goto(origin);
  await signIn(page);
});
await check("page.route: page.title() is the document title", async (page) => {
  await page.route("**/*.png", (route) => route.abort());
  await page.goto(origin);
  expect((await page.title()) === "Probe", `page.title() returned "${await page.title()}"`);
});
await check("page.route: fulfill an in-page fetch", async (page) => {
  await page.route("**/api", (route) => route.fulfill({ json: { mocked: true } }));
  await page.goto(origin);
  expect((await page.evaluate(() => fetch("/api").then((r) => r.json()))).mocked === true, "fetch was not mocked");
});
await check("a second connection sees this connection's pages (external live view)", async (page) => {
  await page.goto(origin);
  const other = await chromium.connectOverCDP(cdpUrl, T);
  try {
    const session = await other.newBrowserCDPSession();
    const { targetInfos } = await session.send("Target.getTargets");
    expect(
      targetInfos.some((t) => t.url.startsWith(origin)),
      "pages are private to the connection that opened them",
    );
  } finally {
    await other.close();
  }
});

await browser.close();
site.close();
