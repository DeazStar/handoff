#!/usr/bin/env node
// What .mcp.json runs for the browser tools: make sure the shared browser is running, then attach Playwright's MCP server to it.
import { spawn } from "node:child_process";
import { ensureBrowser, PORT } from "./browser-lib.mjs";

try {
  await ensureBrowser({ log: (m) => process.stderr.write(`${m}\n`) });
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
}
const child = spawn("npx", ["-y", "@playwright/mcp@0.0.83", "--cdp-endpoint", `http://127.0.0.1:${PORT}`], { stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
