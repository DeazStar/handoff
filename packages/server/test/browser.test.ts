import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JavaScript shared with the scripts folder
import { browserArgs, findBrowser, isRunning, profileDir } from "../../../scripts/browser-lib.mjs";

describe("the shared browser", () => {
  it("opens its control port only to this computer, with the saved profile", () => {
    const args: string[] = browserArgs(9222, "/tmp/profile", {});
    expect(args).toContain("--remote-debugging-port=9222");
    expect(args).toContain("--remote-debugging-address=127.0.0.1");
    expect(args).toContain("--user-data-dir=/tmp/profile");
    expect(args).not.toContain("--headless=new");
    expect(browserArgs(9222, "/tmp/profile", { JOBHUNT_BROWSER_HEADLESS: "1" })).toContain("--headless=new");
  });

  it("keeps the profile with the rest of the data", () => {
    const old = process.env.JOBHUNT_HOME;
    process.env.JOBHUNT_HOME = "/tmp/jh-home";
    expect(profileDir()).toBe("/tmp/jh-home/browser-profile");
    if (old === undefined) delete process.env.JOBHUNT_HOME; else process.env.JOBHUNT_HOME = old;
  });

  it("says whether something answers on the port", async () => {
    const server = http.createServer((req, res) => { res.writeHead(req.url === "/json/version" ? 200 : 404); res.end("{}"); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    expect(await isRunning(port)).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
    expect(await isRunning(port)).toBe(false);
  });

  it("finds the downloaded browser, or the one the user names, and says nothing when there is none", () => {
    const home = mkdtempSync(join(tmpdir(), "jh-browser-"));
    expect(findBrowser({}, home)).toBeUndefined();
    const exe = join(home, "Library", "Caches", "ms-playwright", "chromium-1100", "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS");
    mkdirSync(exe, { recursive: true });
    writeFileSync(join(exe, "Google Chrome for Testing"), "");
    expect(findBrowser({}, home)).toContain("chromium-1100");
    const newer = join(home, "Library", "Caches", "ms-playwright", "chromium-1200", "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS");
    mkdirSync(newer, { recursive: true });
    writeFileSync(join(newer, "Google Chrome for Testing"), "");
    expect(findBrowser({}, home)).toContain("chromium-1200");
    const mine = join(home, "my-chrome");
    writeFileSync(mine, "");
    expect(findBrowser({ JOBHUNT_BROWSER: mine }, home)).toBe(mine);
    expect(findBrowser({ JOBHUNT_BROWSER: join(home, "missing") }, home)).toBeUndefined();
  });
});
