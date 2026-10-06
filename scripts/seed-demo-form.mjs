#!/usr/bin/env node
// Adds two practice jobs to the database that JOBHUNT_HOME points at: one with an open form, one behind a sign-in wall.
// They are matched and ready for /go. Nothing in them is real, and the links point only at the local practice forms.
import { addCandidateJob, openDb, recordVerification, resolveDataPaths, saveJobDetails, setMatch, setRoute, upsertCompany } from "../packages/core/dist/index.js";

const port = process.env.DEMO_FORM_PORT ?? 8099;
const { dbPath } = resolveDataPaths();
const db = openDb(dbPath);

const companyId = upsertCompany(db, { name: "Demo Corp", domain: "demo-corp.example" }, "system");
const jobs = [
  {
    title: "Backend Engineer (Wallets) [practice form]",
    path: "/",
    description: "Demo Corp is hiring a Backend Engineer for its wallet platform. You will build and run Node.js and TypeScript services, design MySQL and MongoDB schemas, and work on microservices and security. Experience with payments or blockchain is a plus. Fully remote, open worldwide.",
    postedBy: "Practice Recruiter, Talent Lead",
  },
  {
    title: "Data Engineer [practice sign-in wall]",
    path: "/signin.html",
    description: "Demo Corp is hiring a Data Engineer to build pipelines in Python and SQL, with graph or document databases a plus. Fully remote, open worldwide.",
    postedBy: "Practice Recruiter, Talent Lead",
  },
];

for (const j of jobs) {
  const url = `http://127.0.0.1:${port}${j.path}`;
  const { id, created } = addCandidateJob(db, { title: j.title, url, canonicalUrl: url, companyId, description: j.description, postedBy: j.postedBy, applyUrl: url }, "system");
  if (!created) { console.log(`Already there: job ${id}  ${j.title}`); continue; }
  recordVerification(db, id, { result: "live", titleMatches: true, applyPathFound: true, evidence: "Practice page on this machine" }, "system");
  setMatch(db, id, 8, "Practice job for testing the apply flow", "system");
  setRoute(db, id, "form", {}, "system");
  console.log(`Added job ${id}  ${j.title}`);
}
console.log(`Database: ${dbPath}`);
console.log(`Next: node scripts/serve-demo-form.mjs  then, in a new Claude session, /go <job id>`);
db.close();
