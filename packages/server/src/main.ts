#!/usr/bin/env node
import { getPreferences, getSyncState, openDb, scanFollowUps } from "@jobhunt/core";
import { createVault } from "@jobhunt/vault";
import { createApp } from "./app.js";
import { createMailer } from "./mail.js";
import { loadConfig } from "./config.js";
import { createImapReader } from "./imap.js";
import { createDrafter, readGapsPrompt } from "./drafter.js";
import { fileURLToPath } from "node:url";
import { createReplySync } from "./replySync.js";

const config = loadConfig();
const db = openDb(config.dbPath);
const vault = createVault(config.dataDir);
const replySync = createReplySync(db, createImapReader(vault));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const drafter = process.env.JOBHUNT_NO_DRAFTER
  ? undefined
  : createDrafter({
      mcpMain: fileURLToPath(new URL("../../mcp/dist/main.js", import.meta.url)),
      prompt: readGapsPrompt(`${repoRoot}.claude/commands/gaps.md`),
      mcpEnv: { JOBHUNT_HOME: config.dataDir, JOBHUNT_DB: config.dbPath },
    });
const server = createApp(db, { token: config.token, dataDir: config.dataDir, vault, mailer: createMailer(vault), replySync, drafter });

// Once a minute: remind about silent applications (free, no mailbox), and, if the user asked for it, check for replies while the vault is unlocked.
const tick = async () => {
  try {
    scanFollowUps(db, "system");
    const minutes = getPreferences(db)?.replyCheckMinutes ?? 0;
    if (minutes > 0 && vault.isUnlocked() && !replySync.isRunning()) {
      const last = getSyncState(db).lastRunAt;
      if (!last || Date.now() - Date.parse(`${last.replace(" ", "T")}Z`) >= minutes * 60_000) await replySync.run();
    }
  } catch {
    // The failure is already recorded for the Replies page; the next tick tries again.
  }
};
const timer = setInterval(tick, 60_000);
timer.unref();

// 127.0.0.1 only: nothing else on the network can reach it.
server.listen(config.port, "127.0.0.1", () => {
  console.log(`Database: ${config.dbPath}`);
  console.log(`Dashboard: http://127.0.0.1:${config.port}/?token=${config.token}`);
});

// Start the shared browser too, so Claude sessions find it already open. Skipped when JOBHUNT_NO_BROWSER is set; a failure never stops the dashboard.
if (!process.env.JOBHUNT_NO_BROWSER) {
  try {
    const lib = (await import(new URL("../../../scripts/browser-lib.mjs", import.meta.url).href)) as { ensureBrowser: (o: { log: (m: string) => void }) => Promise<{ started: boolean }> };
    const r = await lib.ensureBrowser({ log: () => {} });
    console.log(r.started ? "Shared browser: started." : "Shared browser: already running.");
  } catch (e) {
    console.log(`Shared browser: not started (${e instanceof Error ? e.message : e}). Run npm run browser by hand.`);
  }
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
