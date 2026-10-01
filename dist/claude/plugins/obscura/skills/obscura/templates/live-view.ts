// Live view of a page driven through Obscura, served to a local browser tab.
//
// Obscura keeps every CDP connection's pages private to that connection, so a
// separate viewer process cannot see them (its own connection only ever sees
// its own blank page). The capture therefore runs here, inside the connection
// that drives the page, through a second CDP session on the same page.
import http from "node:http";

type CDPSession = { send(method: string, params?: object): Promise<any>; detach(): Promise<void> };
/** The slice of Playwright's `Page` this file needs; avoids importing a Playwright package. */
export type WatchablePage = {
  context(): { newCDPSession(page: any): Promise<CDPSession> };
  isClosed(): boolean;
};

const INTERVAL_MS = 500;
const MAX_QUIET_FAILURES = 10;

const viewer = `<!doctype html>
<html><head><meta charset="utf-8"><title>Obscura live</title>
<style>body{margin:0;background:#111;display:grid;place-items:center;height:100vh}
img{max-width:100%;max-height:100%}</style></head>
<body><img id="s" alt="live page">
<script>
const img = document.getElementById("s");
let old = null;
new EventSource("/events").onmessage = (e) => {
  const bytes = Uint8Array.from(atob(e.data), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
  img.src = url;
  if (old) URL.revokeObjectURL(old);
  old = url;
};
</script></body></html>`;

const clients = new Set<http.ServerResponse>();
let server: http.Server | undefined;
let latest: string | null = null;
let watched: { page: WatchablePage; session: CDPSession } | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let failures = 0;

/** Start the viewer on `port` (loopback only). Resolves to its URL; safe to call again. */
export function startLiveView(port: number): Promise<string> {
  const url = `http://localhost:${port}`;
  if (server) return Promise.resolve(url);
  return new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => {
      if (req.url !== "/events") {
        res.writeHead(200, { "Content-Type": "text/html" }).end(viewer);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      if (latest) res.write(`data:${latest}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
    });
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => {
      server = s;
      // never keep the process alive just for the viewer
      s.unref();
      timer = setTimeout(capture, INTERVAL_MS);
      timer.unref?.();
      resolve(url);
    });
  });
}

/** Point the viewer at `page`. The most recently watched page wins. */
export async function watchPage(page: WatchablePage): Promise<void> {
  const previous = watched;
  watched = { page, session: await page.context().newCDPSession(page) };
  failures = 0;
  await previous?.session.detach().catch(() => {});
}

/** Stop the viewer and release the port. */
export async function stopLiveView(): Promise<void> {
  clearTimeout(timer);
  await watched?.session.detach().catch(() => {});
  watched = null;
  for (const res of clients) res.end();
  clients.clear();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
}

async function capture(): Promise<void> {
  const target = watched;
  // capture only while a tab is watching: an idle viewer costs nothing
  if (target && clients.size > 0 && !target.page.isClosed()) {
    try {
      const shot = await target.session.send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
      failures = 0;
      if (shot.data && shot.data !== latest) {
        latest = shot.data;
        for (const res of clients) res.write(`data:${latest}\n\n`);
      }
    } catch (err) {
      // a capture that races a navigation fails once and recovers; a run of them is a real problem
      if (++failures === MAX_QUIET_FAILURES) console.error(`obscura live view: ${MAX_QUIET_FAILURES} captures failed in a row: ${(err as Error).message}`);
    }
  }
  if (server) {
    timer = setTimeout(capture, INTERVAL_MS);
    timer.unref?.();
  }
}
