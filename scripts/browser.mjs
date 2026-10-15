#!/usr/bin/env node
// Starts the shared browser by hand: npm run browser
import { ensureBrowser, PORT, profileDir } from "./browser-lib.mjs";

try {
  const r = await ensureBrowser({ log: (m) => console.log(m) });
  console.log(r.started ? `The shared browser is open (control port ${PORT}, this computer only).` : `The shared browser is already running (control port ${PORT}).`);
  console.log(`Its logins live in ${profileDir()}. It stays open between Claude sessions. Close its window to stop it.`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
