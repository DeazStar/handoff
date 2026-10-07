#!/usr/bin/env node
// Adds four practice jobs, all scored 6, that differ only in remote scope and sponsorship, to the database JOBHUNT_HOME points at.
// Open the Pipeline page and switch the priority setting to watch the order change. Nothing here is real.
import { addCandidateJob, openDb, recordVerification, resolveDataPaths, setMatch, upsertCompany } from "../packages/core/dist/index.js";

const { dbPath } = resolveDataPaths();
const db = openDb(dbPath);
const companyId = upsertCompany(db, { name: "Ranking Demo Ltd", domain: "ranking-demo.example" }, "system");

const jobs = [
  ["Plain On-site Engineer [ranking demo]", {}],
  ["Worldwide Remote Engineer [ranking demo]", { remoteScope: "worldwide" }],
  ["Sponsoring Engineer [ranking demo]", { sponsorship: "confirmed", sponsorshipEvidence: "We offer visa sponsorship and relocation (practice text)" }],
  ["Register-listed Engineer [ranking demo]", { sponsorship: "likely", sponsorshipEvidence: "Listed on a sponsor register (practice data)" }],
];
for (const [title, signals] of jobs) {
  const url = `https://ranking-demo.example/jobs/${encodeURIComponent(title)}`;
  const { id, created } = addCandidateJob(db, { title, url, canonicalUrl: url, companyId }, "system");
  if (!created) { console.log(`Already there: job ${id}  ${title}`); continue; }
  recordVerification(db, id, { result: "live", evidence: "Practice job" }, "system");
  setMatch(db, id, 6, "Practice job for testing the ranking", "system", signals);
  console.log(`Added job ${id}  ${title}`);
}
console.log(`Database: ${dbPath}`);
db.close();
