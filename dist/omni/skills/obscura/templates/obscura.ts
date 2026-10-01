// Playwright Test on Obscura. Import `test` and `expect` from this file instead
// of "@playwright/test"; without OBSCURA_CDP_URL it is the stock `test`, so the
// project's normal browser run is unchanged.
//
//   OBSCURA_CDP_URL    ws://127.0.0.1:<port> of a running `obscura serve`
//   OBSCURA_LIVE_VIEW  port for the live viewer (optional; use with --workers=1)
import { test as base, chromium, type Browser } from "@playwright/test";
import { startLiveView, watchPage } from "./live-view";

const cdpUrl = process.env.OBSCURA_CDP_URL;
const liveViewPort = process.env.OBSCURA_LIVE_VIEW;

const onObscura = base.extend<{ obscuraLiveView: void }, { browser: Browser }>({
  // connectOverCDP, not connectOptions.wsEndpoint: that option speaks Playwright's
  // own protocol, which Obscura does not implement (the connect times out).
  // No dependency on the stock `browser` fixture, so bundled Chromium never launches.
  browser: [
    async ({}, use) => {
      const browser = await chromium.connectOverCDP(cdpUrl!);
      await use(browser);
      await browser.close();
    },
    { scope: "worker" },
  ],
  obscuraLiveView: [
    async ({ page }, use) => {
      if (liveViewPort) {
        await startLiveView(Number(liveViewPort));
        await watchPage(page);
      }
      await use();
    },
    { auto: true },
  ],
});

export const test = cdpUrl ? onObscura : base;
export { expect } from "@playwright/test";
