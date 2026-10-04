#!/usr/bin/env node
// Usage: jobhunt-import-cv path/to/cv.json
// Loads jobs, projects, education and skills into an empty CV. Review the result on the CV page.
import { readFileSync } from "node:fs";
import { createHumanApi, openDb, resolveDataPaths, type CvImport } from "@jobhunt/core";

const file = process.argv[2];
if (!file) {
  console.error("Usage: jobhunt-import-cv path/to/cv.json");
  process.exit(1);
}
const { dbPath } = resolveDataPaths();
const db = openDb(dbPath);
try {
  const result = createHumanApi(db).importCv(JSON.parse(readFileSync(file, "utf8")) as CvImport);
  console.log(`Imported into ${dbPath}: ${result.entries} entries, ${result.bullets} bullets, ${result.skills} skills.`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  db.close();
}
