// One shared browser for every Claude session.
//
// Playwright's own browser keeps its logins in a profile folder, and a profile can be used by only one browser at a time, so a second
// session could not start a browser while the first still held it. Here one Chromium is started on its own, with that same profile and a
// control port that only this computer can reach, and every session attaches to it instead of starting one. It keeps running between
// sessions, so a filled form also survives a session ending.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import http from "node:http";

export const PORT = Number(process.env.JOBHUNT_BROWSER_PORT ?? 9222);
export const profileDir = () => join(process.env.JOBHUNT_HOME ?? join(homedir(), ".jobhunt"), "browser-profile");

/** Is something answering on the control port? */
export function isRunning(port = PORT, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: "/json/version", timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

/** The browser Playwright downloaded, or JOBHUNT_BROWSER if the user points at another Chromium or Chrome. */
export function findBrowser(env = process.env, home = homedir()) {
  if (env.JOBHUNT_BROWSER) return existsSync(env.JOBHUNT_BROWSER) ? env.JOBHUNT_BROWSER : undefined;
  const cache = join(home, "Library", "Caches", "ms-playwright");
  const linuxCache = join(home, ".cache", "ms-playwright");
  for (const root of [cache, linuxCache]) {
    if (!existsSync(root)) continue;
    const dirs = readdirSync(root).filter((d) => d.startsWith("chromium-")).sort().reverse();
    for (const d of dirs) {
      for (const rel of [
        "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
        "chrome-linux/chrome",
      ]) {
        const p = join(root, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  for (const p of ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"]) if (existsSync(p)) return p;
  return undefined;
}

/** The arguments that make the browser reachable only from this computer, with the saved profile. */
export function browserArgs(port = PORT, profile = profileDir(), env = process.env) {
  return [
    ...(env.JOBHUNT_BROWSER_HEADLESS === "1" ? ["--headless=new"] : []),
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    // Brings back the last session's tabs and, with them, the logins that sites keep in session cookies. (A start page address would cancel this.)
    "--restore-last-session",
  ];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sites keep a login in a "session cookie", which Chrome throws away when it closes unless it is told to continue where it left off.
 * This sets that in the browser's own settings before it starts. The launch also passes --restore-last-session: both are needed, and either alone loses the login.
 */
export function keepLogins(profile = profileDir()) {
  const dir = join(profile, "Default");
  const file = join(dir, "Preferences");
  let prefs = {};
  try { prefs = JSON.parse(readFileSync(file, "utf8")); } catch { /* a new profile has none yet */ }
  const next = { ...prefs, session: { ...(prefs.session || {}), restore_on_startup: 1 }, profile: { ...(prefs.profile || {}), exit_type: "Normal", exited_cleanly: true } };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(next));
}

/** Makes sure the shared browser is running, starting it (detached, so it outlives this process) when it is not. */
export async function ensureBrowser({ port = PORT, log = () => {} } = {}) {
  if (await isRunning(port)) return { started: false, port };
  keepLogins();
  const exe = findBrowser();
  if (!exe) {
    throw new Error("No Chromium found. Install it once with: npx playwright install chromium (or set JOBHUNT_BROWSER to a Chrome or Chromium program).");
  }
  const profile = profileDir();
  mkdirSync(profile, { recursive: true });
  log(`Starting the shared browser with the saved profile in ${profile}`);
  const child = spawn(exe, browserArgs(port, profile), { detached: true, stdio: "ignore" });
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await isRunning(port)) return { started: true, port };
    await sleep(500);
  }
  throw new Error(`The browser did not open its control port ${port}. If an older browser window from a previous session is still open on the same profile, close it once and try again.`);
}
