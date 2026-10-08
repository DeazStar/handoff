#!/usr/bin/env node
import { getPreferences, getSyncState, openDb, scanFollowUps } from "@jobhunt/core";
import { createVault } from "@jobhunt/vault";
import { createApp } from "./app.js";
import { createMailer } from "./mail.js";
import { loadConfig } from "./config.js";
import { createImapReader } from "./imap.js";
import { createReplySync } from "./replySync.js";

const config = loadConfig();
const db = openDb(config.dbPath);
const vault = createVault(config.dataDir);
const replySync = createReplySync(db, createImapReader(vault));
const server = createApp(db, { token: config.token, dataDir: config.dataDir, vault, mailer: createMailer(vault), replySync });

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

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
