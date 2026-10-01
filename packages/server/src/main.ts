#!/usr/bin/env node
import { openDb } from "@jobhunt/core";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const db = openDb(config.dbPath);
const server = createApp(db, { token: config.token });

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
