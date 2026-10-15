#!/usr/bin/env node
// Fills an EMPTY data folder with a made-up job hunt, so you can look around the dashboard before using your own data.
//
//   JOBHUNT_HOME=/tmp/handoff-demo npm run demo:data
//   JOBHUNT_HOME=/tmp/handoff-demo JOBHUNT_NO_BROWSER=1 JOBHUNT_NO_DRAFTER=1 npm start -w @jobhunt/server
//
// Everything here is fictional: a person called Alex Morgan, invented companies and example.com addresses. Nothing is sent anywhere.
// It refuses to run if the database already has a profile, so it can never mix with real data.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addBullet, addContact, addEntry, createAgentApi, createHumanApi, draftEmail, getProfile, importDirectory, ingestMessages, markApplicationSubmitted,
  openDb, prepareApplication, prepareCover, prepareCv, recordVerification, reportGap, requestMetricCards, resolveDataPaths, saveCvScore, saveDocument,
  saveJobDetails, scoreCv, setCompanyVerdict, setMatch, setPreferences, setProfile, setRoute, setSkillGroup, setStandardAnswer, transitionJob, upsertCompany,
  addCandidateJob,
} from "../packages/core/dist/index.js";
import { renderCoverPdf, renderCvPdf } from "../packages/render/dist/index.js";

const { dataDir, dbPath } = resolveDataPaths();
mkdirSync(join(dataDir, "documents"), { recursive: true });
const db = openDb(dbPath);
if (getProfile(db)) {
  console.error(`The database at ${dbPath} already has a profile. Point JOBHUNT_HOME at an empty folder, for example JOBHUNT_HOME=/tmp/handoff-demo.`);
  process.exit(1);
}
const H = "human";
const A = "agent";
const agent = createAgentApi(db);
const human = createHumanApi(db);

// ---- who you are ----
setProfile(db, {
  fullName: "Alex Morgan", email: "alex@example.com", phone: "+351 913 579 246", location: "Lisbon, Portugal",
  links: ["https://github.com/alex-morgan-demo", "https://www.linkedin.com/in/alex-morgan-demo/"], languages: ["English", "Portuguese"],
  workAuthorization: "Authorized to work in the EU", noticePeriod: "2 weeks", requiresSponsorship: false,
}, H);
setPreferences(db, {
  roles: ["Backend Engineer", "Full-Stack Engineer"], seniority: ["mid", "senior"], locations: ["Remote", "Lisbon"], remotePolicy: "remote",
  industries: [], exclusions: ["crypto"], salaryFloor: 3000, salaryTarget: 4200, salaryCeiling: 5500, currency: "EUR", salaryPeriod: "month",
  dailyApplicationLimit: 5, dailyDiscoveryLimit: 10, searchAnySite: true, batchSize: 10, coverLetters: "auto",
  writingStyle: "Short, plain sentences. No jargon, no flattery. Say what I did and what came of it.",
}, H);
setStandardAnswer(db, "Are you willing to relocate?", "No, I work remotely from Lisbon", H);
setStandardAnswer(db, "How did you hear about us?", "A job board", H);

// ---- your work ----
const northwind = addEntry(db, { kind: "work", title: "Lead Backend Engineer", organization: "Northwind", location: "Remote", startDate: "2023-08", isCurrent: true, weight: "lead" }, H);
const contoso = addEntry(db, { kind: "work", title: "Backend Engineer", organization: "Contoso", location: "Remote", startDate: "2024-08", isCurrent: true }, H);
const fabrikam = addEntry(db, { kind: "work", title: "Software Engineer", organization: "Fabrikam", location: "Lisbon, Portugal", startDate: "2023-03", endDate: "2023-07" }, H);
const booking = addEntry(db, { kind: "project", title: "BookingsHub" }, H);
const tracker = addEntry(db, { kind: "project", title: "Expense tracker" }, H);
addEntry(db, { kind: "education", title: "BSc in Software Engineering", organization: "University of Lisbon", startDate: "2019", endDate: "2023" }, H);

const n1 = addBullet(db, northwind, "Leading backend architecture and development for a payments platform that connects merchants with banks across Kenya.", H);
const n2 = addBullet(db, northwind, "Designing and building REST APIs and authentication systems for sensitive payment data.", H);
const n3 = addBullet(db, northwind, "Responsible for database schema design and performance optimization, and for security standards across the services.", H);
const n4 = addBullet(db, northwind, "Managing deployment workflows with CI/CD and Docker, keeping the system reliable for a growing user base.", H);
const c1 = addBullet(db, contoso, "Developed backend APIs for data ingestion and reporting pipelines, cutting query time by more than 60 percent.", H);
const c2 = addBullet(db, contoso, "Implemented input validation, access control and secure data handling across all services.", H);
const c3 = addBullet(db, contoso, "Designed the authentication layer used by the reporting dashboard.", H);
const f1 = addBullet(db, fabrikam, "Built a full-stack e-commerce platform in TypeScript, Node.js, Next.js and React.", H);
const f2 = addBullet(db, fabrikam, "Optimized server logic and database interactions, improving UI performance by 20%.", H);
const p1 = addBullet(db, booking, "MERN-stack accommodation booking platform with input sanitization and injection protection.", H);
const t1 = addBullet(db, tracker, "Personal expense tracker with offline sync, built in Flutter with a Node.js API.", H);
setSkillGroup(db, "Backend", ["Node.js", "TypeScript", "Python", "Express"], H);
setSkillGroup(db, "Frontend", ["React", "Next.js"], H);
setSkillGroup(db, "Databases", ["PostgreSQL", "Redis", "MongoDB"], H);
setSkillGroup(db, "Infrastructure", ["Docker", "CI/CD", "Git"], H);
const skill = (t) => db.prepare("SELECT id FROM facts WHERE kind = 'skill' AND text = ?").get(t).id;

// ---- a company list, some already judged ----
importDirectory(db, [
  { name: "Globex", website: "https://globex.example", location: "Remote", oneLiner: "Release tracking for mobile teams", industry: "Developer tools", teamSize: 35, remoteHint: "fully", source: "demo", sourceRef: "globex" },
  { name: "Acme Labs", website: "https://acmelabs.example", location: "New York, NY / Remote", oneLiner: "Fractional ownership of investment properties", industry: "Fintech", teamSize: 18, remoteHint: "partly", source: "demo", sourceRef: "acme-labs" },
  { name: "Initrode", website: "https://initrode.example", location: "Remote", oneLiner: "Payroll for distributed teams", industry: "HR tech", teamSize: 60, remoteHint: "fully", source: "demo", sourceRef: "initrode" },
  { name: "Soylent Pay", website: "https://soylentpay.example", location: "London, UK / Remote", oneLiner: "Checkout for marketplaces", industry: "Payments", teamSize: 120, remoteHint: "partly", source: "demo", sourceRef: "soylent-pay" },
  { name: "Vandelay Systems", website: "https://vandelay.example", location: "Remote", oneLiner: "Import and export paperwork, automated", industry: "Logistics", teamSize: 22, remoteHint: "fully", source: "demo", sourceRef: "vandelay" },
  { name: "Tyrell Data", website: "https://tyrelldata.example", location: "Remote", oneLiner: "Data pipelines for retailers", industry: "Data", teamSize: 45, remoteHint: "fully", source: "demo", sourceRef: "tyrell-data" },
  { name: "Wonka Foods", website: "https://wonka.example", location: "Berlin, Germany", oneLiner: "Online grocery delivery", industry: "Consumer", teamSize: 300, source: "demo", sourceRef: "wonka" },
  { name: "Umbrella Health", website: "https://umbrellahealth.example", location: "Remote", oneLiner: "Scheduling for clinics", industry: "Health", teamSize: 80, remoteHint: "fully", source: "demo", sourceRef: "umbrella" },
  { name: "Hooli Maps", website: "https://hoolimaps.example", location: "Remote", oneLiner: "Indoor maps for venues", industry: "Maps", teamSize: 28, remoteHint: "fully", source: "demo", sourceRef: "hooli-maps" },
  { name: "Pied Piper Cloud", website: "https://piedpiper.example", location: "Remote", oneLiner: "Compression as a service", industry: "Infrastructure", teamSize: 15, remoteHint: "fully", source: "demo", sourceRef: "pied-piper" },
], "system");
const idOfCompany = (name) => db.prepare("SELECT id FROM companies WHERE name = ?").get(name).id;
for (const [name, careers] of [["Globex", "https://globex.example/careers"], ["Acme Labs", "https://acmelabs.example/jobs"], ["Initrode", "https://initrode.example/careers"], ["Soylent Pay", "https://soylentpay.example/careers"], ["Vandelay Systems", "https://vandelay.example/jobs"], ["Tyrell Data", "https://tyrelldata.example/careers"], ["Hooli Maps", "https://hoolimaps.example/careers"]]) {
  db.prepare("UPDATE companies SET careers_status = 'found', careers_url = ?, careers_checked_at = datetime('now') WHERE id = ?").run(careers, idOfCompany(name));
}
setCompanyVerdict(db, idOfCompany("Globex"), "potential", "Software Engineer opening, React and TypeScript web app, fully remote", H);
setCompanyVerdict(db, idOfCompany("Acme Labs"), "potential", "Product Engineer opening that covers both frontend and backend", H);
setCompanyVerdict(db, idOfCompany("Wonka Foods"), "discarded", "On-site in Berlin, no remote option listed", H);
setCompanyVerdict(db, idOfCompany("Umbrella Health"), "discarded", "Only a data-science opening, nothing for backend", H);

// ---- jobs in every stage ----
function job(company, title, description, extra = {}) {
  const slug = company.toLowerCase().replace(/[^a-z]+/g, "");
  const known = db.prepare("SELECT domain FROM companies WHERE name = ?").get(company);
  const companyId = upsertCompany(db, { name: company, domain: known?.domain ?? `${slug}.example` }, A);
  const url = `https://${slug}.example/jobs/${title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  const { id } = addCandidateJob(db, { title, url, canonicalUrl: url, companyId, description, applyUrl: url, remote: true, location: "Remote" }, A);
  recordVerification(db, id, { result: "live", titleMatches: true, applyPathFound: true, evidence: "Posting is open and shows an Apply button" }, A);
  if (extra.score !== undefined) setMatch(db, id, extra.score, extra.reason, A, { remoteScope: extra.remoteScope ?? "worldwide", sponsorship: "unknown", seniority: extra.seniority ?? "mid" });
  if (extra.route) setRoute(db, id, extra.route, { applyUrl: url }, A);
  return { id, companyId, url };
}
const keywords = [
  { term: "TypeScript", critical: true }, { term: "Node.js", critical: true, synonyms: ["NodeJS"] }, { term: "React", critical: true },
  { term: "PostgreSQL", critical: true, synonyms: ["Postgres"] }, { term: "REST", synonyms: ["REST APIs"] }, { term: "Docker" }, { term: "Kubernetes", critical: true }, { term: "Go", synonyms: ["Golang"] },
];

// 1. An email job with a CV, cover letter and an email draft waiting for approval
const globex = job("Globex", "Software Engineer", "Globex builds release tracking for mobile teams. Backend in Go, web app in React and TypeScript. Fully remote. You will own features end to end, with PostgreSQL and Docker in the stack.", { score: 8, reason: "React, TypeScript and PostgreSQL match. The Go backend is a gap.", route: "email" });
const cvPlan = {
  headline: "Backend Software Engineer",
  summary: [
    { text: "Software Engineer with 3+ years building backend APIs and web products in TypeScript, Node.js, React and PostgreSQL.", factIds: [skill("TypeScript"), skill("Node.js"), skill("React"), skill("PostgreSQL")] },
    { text: "Experienced in REST API design, authentication and database design, and in CI/CD and Docker deployments.", factIds: [n2, n3, n4] },
    { text: "Known for owning backend systems from design to deployment in remote startup teams.", factIds: [n1, n4] },
  ],
  experience: [
    { entryId: northwind, bullets: [n1, n2, n3, n4] },
    { entryId: contoso, bullets: [c1, c2] },
    { entryId: fabrikam, bullets: [f1, f2] },
  ],
  projects: [{ entryId: booking, bullets: [p1] }],
  education: [{ entryId: db.prepare("SELECT id FROM cv_entries WHERE kind = 'education'").get().id }],
  skills: [
    { group: "Backend", factIds: ["Node.js", "TypeScript", "Python", "Express"].map(skill) }, { group: "Frontend", factIds: ["React", "Next.js"].map(skill) },
    { group: "Databases", factIds: ["PostgreSQL", "Redis", "MongoDB"].map(skill) }, { group: "Infrastructure", factIds: ["Docker", "CI/CD", "Git"].map(skill) },
  ],
};
async function saveCv(jobId, plan, name) {
  const { cv, blocks, factIds } = prepareCv(db, plan, jobId);
  const { pdf, pages } = await renderCvPdf(cv);
  const rel = join("documents", `${name}-cv-v1.pdf`);
  writeFileSync(join(dataDir, rel), pdf);
  const saved = saveDocument(db, { jobId, kind: "cv", path: rel, blocks, plan, extraFactIds: factIds }, A);
  saveCvScore(db, saved.id, scoreCv(db, saved.id, keywords, pages), A);
  return saved;
}
await saveCv(globex.id, cvPlan, "globex");
const coverPlan = {
  paragraphs: [
    { text: "I'm applying for the Software Engineer role at Globex. I'm a software engineer with 3+ years building backend APIs and web products in TypeScript, Node.js, React and PostgreSQL. Your web app is built in React and TypeScript, which I used to build a full-stack e-commerce platform at Fabrikam. There I also optimized server logic and database interactions and improved UI performance by 20%.", factIds: [f1, f2, skill("TypeScript")] },
    { text: "I lead backend work at Northwind, a payments platform that connects merchants with banks across Kenya. I design its REST APIs and authentication for sensitive payment data, own the database schema and performance, and manage the CI/CD and Docker deployments that keep the system reliable for a growing user base.", factIds: [n1, n2, n3, n4] },
    { text: "At Contoso I developed the backend APIs for data ingestion and for integration with reporting pipelines, and cut query time by more than 60 percent. I also put input validation and access control in place across the services. Outside work I built a mobile app in Flutter with a Node.js API, so mobile work is familiar to me.", factIds: [c1, c2, t1] },
    { text: "Happy to talk if it looks like a fit. Thank you for your time and consideration.", factIds: [] },
  ],
};
{
  const { cover, blocks, factIds } = prepareCover(db, coverPlan, globex.id);
  const { pdf } = await renderCoverPdf(cover);
  const rel = join("documents", "globex-cover-v1.pdf");
  writeFileSync(join(dataDir, rel), pdf);
  saveDocument(db, { jobId: globex.id, kind: "cover", path: rel, blocks, plan: coverPlan, extraFactIds: factIds }, A);
}
transitionJob(db, globex.id, "materials_ready", A, "CV built");
const jobsContact = addContact(db, { companyId: globex.companyId, email: "jobs@globex.example", sourceUrl: "https://globex.example/careers" }, A);
draftEmail(db, {
  jobId: globex.id, contactId: jobsContact,
  blocks: [
    { text: "Dear Hiring Manager,", factIds: [], kind: "boilerplate" },
    { text: "I'm applying for the Software Engineer role at Globex.", factIds: [], kind: "boilerplate" },
    { text: "I'm a software engineer with 3+ years building backend APIs and web products in TypeScript, Node.js, React and PostgreSQL, and I lead backend work on a payments platform.", factIds: [skill("TypeScript"), skill("Node.js"), skill("React"), skill("PostgreSQL"), n1], kind: "claim" },
    { text: "My CV and cover letter are attached. Happy to talk if it looks like a fit.", factIds: [], kind: "boilerplate" },
    { text: "Best regards,", factIds: [], kind: "boilerplate" },
  ],
}, A);
reportGap(db, globex.id, { requirement: "Go backend services", detail: "The posting's backend is written in Go; none of your facts mention Go.", importance: "nice_to_have", closestFactIds: [n1, c1] }, A);

// 2. A form job with a filled form waiting for review
const acme = job("Acme Labs", "Product Engineer", "Acme Labs is building a platform for fractional ownership of investment properties. You will own features across the frontend and backend with TypeScript, React, Node.js and PostgreSQL. Full-time, remote friendly.", { score: 7, reason: "Both frontend and backend, and the stack matches.", route: "form" });
await saveCv(acme.id, { ...cvPlan, headline: "Full-Stack Software Engineer" }, "acme");
transitionJob(db, acme.id, "materials_ready", A, "CV built");
prepareApplication(db, {
  jobId: acme.id, formUrl: "https://acmelabs.example/apply/product-engineer",
  answers: [
    { question: "Full name", answer: "Alex Morgan", kind: "profile", from: ["profile:fullName"] },
    { question: "Email", answer: "alex@example.com", kind: "profile", from: ["profile:email"] },
    { question: "Are you willing to relocate?", answer: "No, I work remotely from Lisbon", kind: "standard", from: ["standard:Are you willing to relocate?"] },
    { question: "Years of experience", answer: "3", kind: "profile", from: ["profile:experienceYears"] },
  ],
  leftBlank: [{ question: "Gender", why: "Demographic question with no saved answer; left for you" }, { question: "I agree to the privacy policy", why: "Consent boxes are ticked only when you say so" }],
}, A);

// 3. Earlier stages
job("Initrode", "Backend Engineer", "Initrode runs payroll for distributed teams. Node.js and PostgreSQL services, queues and an events pipeline. Remote, EU time zones.", { score: 7, reason: "Node.js and PostgreSQL match, EU time zone fits.", route: "email" });
job("Soylent Pay", "Senior Backend Engineer", "Soylent Pay builds checkout for marketplaces. Scala and Kafka experience preferred. Hybrid in London or remote in Europe.", { score: 5, reason: "Seniority fits but the stack (Scala, Kafka) is far from yours.", seniority: "senior" });
job("Vandelay Systems", "Full-Stack Engineer", "Vandelay automates import and export paperwork. React, Node.js, PostgreSQL. Fully remote.", {});
job("Hooli Maps", "Backend Engineer, Indoor Maps", "Hooli Maps builds indoor maps for venues. Python, PostGIS and an APIs team. Remote.", { score: 6, reason: "Python and PostgreSQL match; PostGIS is new.", route: "form" });

// 4. An application that went out, and a reply from the company's own address
const tyrell = job("Tyrell Data", "Data Platform Engineer", "Tyrell Data builds data pipelines for retailers. Python, SQL and Node.js. Fully remote.", { score: 7, reason: "Pipelines and PostgreSQL match your Contoso work.", route: "form" });
await saveCv(tyrell.id, cvPlan, "tyrell");
transitionJob(db, tyrell.id, "materials_ready", A, "CV built");
prepareApplication(db, { jobId: tyrell.id, formUrl: "https://tyrelldata.example/apply/1", answers: [{ question: "Full name", answer: "Alex Morgan", kind: "profile", from: ["profile:fullName"] }], leftBlank: [] }, A);
markApplicationSubmitted(db, tyrell.id, H);
ingestMessages(db, [{
  messageId: "<demo-1@tyrelldata.example>", fromAddr: "recruiting@tyrelldata.example", fromName: "Priya from Tyrell Data", subject: "Your application: Data Platform Engineer",
  receivedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
  snippet: "Hi Alex, thanks for applying. We would like to set up a short call to talk about the role. Are you free on Thursday or Friday afternoon?",
}], "system");

// 5. Cards that wait for you: gaps, and bullets that need a number
reportGap(db, acme.id, { requirement: "Kubernetes in production", detail: "The posting lists Kubernetes; your facts cover Docker and CI/CD only.", importance: "required", closestFactIds: [n4] }, A);
requestMetricCards(db, 3, H);

console.log(`Demo data created in ${dataDir}`);
console.log(`Jobs: ${db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n}, companies: ${db.prepare("SELECT COUNT(*) AS n FROM companies").get().n}, facts: ${db.prepare("SELECT COUNT(*) AS n FROM facts").get().n}`);
db.close();
