#!/usr/bin/env node
// Resets today's application count: npm run reset-limit
// Only you can do this (Claude cannot): the limit is your guard on what Claude prepares and sends.
import { applicationRoom, openDb, resetApplicationCount, resolveDataPaths } from "../packages/core/dist/index.js";

const { dbPath } = resolveDataPaths();
const db = openDb(dbPath);
const before = applicationRoom(db);
resetApplicationCount(db, "human");
const after = applicationRoom(db);
console.log(`Today's count was ${before.used} of ${before.limit}. It is now ${after.used} of ${after.limit}.`);
