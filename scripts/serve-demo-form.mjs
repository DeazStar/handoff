#!/usr/bin/env node
// Serves the practice forms in fixtures/demo-form on http://127.0.0.1:8099 so the apply flow can be tried safely.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = new URL("../fixtures/demo-form/", import.meta.url);
const pages = { "/": "index.html", "/index.html": "index.html", "/signin.html": "signin.html" };
const port = Number(process.env.DEMO_FORM_PORT ?? 8099);

createServer((req, res) => {
  const file = pages[(req.url ?? "/").split("?")[0]];
  if (!file) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("Not found"); }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(readFileSync(new URL(file, dir)));
}).listen(port, "127.0.0.1", () => {
  console.log(`Practice forms: http://127.0.0.1:${port}/  and  http://127.0.0.1:${port}/signin.html`);
  console.log(`(files from ${fileURLToPath(dir)})  Press Ctrl-C to stop.`);
});
