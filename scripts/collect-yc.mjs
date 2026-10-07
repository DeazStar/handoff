#!/usr/bin/env node
// Fills the company list from Y Combinator's public directory (companies that say they are hiring).
// One download, no model. Run it again any time: it updates what it added and adds the new ones.
import { collectYc, directoryStats, importDirectory, openDb, resolveDataPaths } from "../packages/core/dist/index.js";

const { dbPath } = resolveDataPaths();
const db = openDb(dbPath);
const { companies, rejected } = await collectYc();
const r = importDirectory(db, companies, "system");
const s = directoryStats(db);
console.log(`YC: ${companies.length} companies read, ${rejected} skipped as not active. Added ${r.added}, updated ${r.updated}, left alone ${r.skipped}.`);
console.log(`Company list now: ${s.total} companies (${s.bySource.map((x) => `${x.source} ${x.companies}, ${x.remote} remote`).join("; ")}).`);
console.log(`Database: ${dbPath}`);
db.close();
