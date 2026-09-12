// Local mock of a small business website for manual testing with `wrangler dev`.
// Serves the same fixture the automated tests use, rewritten to http://127.0.0.1.
// Usage: node scripts/mock-site.mjs [port]   (default 80; the auditor only accepts default ports)
// Then: DEV_ALLOW_LOOPBACK_TARGETS=1 wrangler dev  and audit http://127.0.0.1/
import { createServer } from "node:http";
import { ROUTES, SITE } from "../test/helpers/fakeSite.ts";

const port = Number(process.argv[2] ?? 80);
const LOCAL = `http://127.0.0.1${port === 80 ? "" : `:${port}`}`;
const rewrite = (s) => s.replaceAll(SITE, LOCAL).replaceAll("https://acmeplumbing.com.au", LOCAL);

createServer((req, res) => {
  const key = `${SITE}${req.url}`;
  const route = ROUTES[key] ?? ROUTES[`${key}/`];
  if (!route) {
    res.writeHead(404, { "content-type": "text/html" }).end("not found");
    return;
  }
  const headers = { "content-type": "text/html; charset=utf-8", ...(route.headers ?? {}) };
  if (headers.location) headers.location = rewrite(headers.location);
  const body = route.body ? rewrite(route.body) : "";
  const status = route.status ?? 200;
  setTimeout(() => {
    res.writeHead(status, headers);
    res.end(status >= 300 && status < 400 ? undefined : body);
  }, route.delayMs ?? 0);
}).listen(port, "127.0.0.1", () => console.log(`mock site on ${LOCAL}`));
