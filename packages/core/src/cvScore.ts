import type { DB } from "./db.js";
import { getDocument } from "./documents.js";
import { getEntry, listEntries, experienceSummary, type CvEntry } from "./cv.js";
import { getFacts } from "./facts.js";
import { getProfile } from "./profile.js";
import type { CvPlan, ResolvedCv } from "./cvPlan.js";
import { logEvent } from "./jobs.js";
import type { Actor } from "./states.js";

/** A word or phrase from the posting. critical: the posting lists it as required or as a core skill. synonyms count as the same keyword. */
export interface ScoreKeyword {
  term: string;
  critical?: boolean;
  synonyms?: string[];
}

export interface KeywordResult {
  term: string;
  critical: boolean;
  found: boolean;
  count: number;
  where: ("summary" | "skills" | "experience" | "projects" | "headline")[];
}

export interface CvScore {
  score: number;
  parts: { formatting: number; keywords: number; evidence: number; summary: number };
  coverage: number;
  keywords: KeywordResult[];
  missing: string[];
  issues: string[];
  scoredAt?: string;
}

const MAX_PAGES = 2;

/** A pattern that finds the term as a whole word, tolerating "Node.js", "node js" and "nodejs": any dot, space or hyphen may be missing or present. */
function termPattern(term: string): RegExp {
  const letters = [...term.trim().toLowerCase().replace(/[ .\-]+/g, "")];
  const body = letters.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[ .\\-]?");
  return new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`, "gi");
}

/**
 * Reads a saved plan into the text it put on the page, without re-checking it against today's writing rules:
 * the score describes the CV as it is, including one saved before a rule existed.
 */
function readPlan(db: DB, plan: CvPlan): ResolvedCv {
  const ids = new Set<number>();
  for (const b of plan.summary ?? []) b.factIds.forEach((i) => ids.add(i));
  for (const g of plan.skills ?? []) g.factIds.forEach((i) => ids.add(i));
  for (const sec of [...(plan.experience ?? []), ...(plan.projects ?? [])]) for (const b of sec.bullets) typeof b === "number" ? ids.add(b) : b.factIds.forEach((i) => ids.add(i));
  const facts = new Map(getFacts(db, [...ids]).map((f) => [f.id, f]));
  const bulletsOf = (list: CvPlan["experience"]) =>
    (list ?? []).flatMap((item) => {
      const entry = getEntry(db, item.entryId);
      if (!entry) return [];
      const bullets = item.bullets.map((b) => (typeof b === "number" ? facts.get(b)?.text ?? "" : b.text)).filter(Boolean);
      return [{ entry: entry as CvEntry, bullets }];
    });
  const profile = getProfile(db);
  return {
    header: { name: profile?.fullName ?? "", headline: plan.headline, email: profile?.email, phone: profile?.phone, location: profile?.location, links: profile?.links ?? [] },
    summary: (plan.summary ?? []).map((b) => b.text),
    experience: bulletsOf(plan.experience),
    projects: bulletsOf(plan.projects),
    education: [],
    skills: (plan.skills ?? []).map((g) => ({ group: g.group, items: g.factIds.map((i) => facts.get(i)?.text ?? "").filter(Boolean) })),
  };
}

function sections(cv: ResolvedCv): Record<KeywordResult["where"][number], string> {
  return {
    headline: cv.header.headline ?? "",
    summary: cv.summary.join(" "),
    skills: cv.skills.map((g) => g.items.join(" ")).join(" "),
    experience: cv.experience.map((e) => `${e.entry.title} ${e.entry.organization ?? ""} ${e.bullets.join(" ")}`).join(" "),
    projects: cv.projects.map((p) => `${p.entry.title} ${p.bullets.join(" ")}`).join(" "),
  };
}

/**
 * Scores a saved CV the way an applicant tracking system reads it, out of 100:
 * formatting 30 (the layout is fixed and plain, so it only loses points for a missing contact or too many pages),
 * keywords 30 (how many of the posting's keywords are on the CV, critical ones counting double; the target is 80%),
 * evidence 20 (bullets that carry a number) and summary 20 (present, states the years, uses a job keyword, has a headline).
 * It reads the CV only. It never adds anything: a missing keyword the user has no fact for stays missing.
 */
export function scoreCv(db: DB, documentId: number, keywords: ScoreKeyword[], pages?: number): CvScore {
  const doc = getDocument(db, documentId);
  if (!doc || doc.kind !== "cv") throw new Error(`Document ${documentId} is not a CV`);
  if (!doc.plan) throw new Error("This CV has no saved plan to read");
  if (!keywords.length) throw new Error("Give the keywords from the posting");
  const cv = readPlan(db, doc.plan as CvPlan);
  const text = sections(cv);
  const all = Object.values(text).join(" \n ");

  const results: KeywordResult[] = keywords.map((k) => {
    const terms = [k.term, ...(k.synonyms ?? [])];
    const where: KeywordResult["where"] = [];
    let count = 0;
    for (const [name, body] of Object.entries(text) as [KeywordResult["where"][number], string][]) {
      const n = terms.reduce((sum, t) => sum + (body.match(termPattern(t))?.length ?? 0), 0);
      if (n > 0) { where.push(name); count += n; }
    }
    return { term: k.term, critical: k.critical === true, found: count > 0, count, where };
  });
  const weight = (r: KeywordResult) => (r.critical ? 2 : 1);
  const total = results.reduce((s, r) => s + weight(r), 0);
  const got = results.reduce((s, r) => s + (r.found ? weight(r) : 0), 0);
  const coverage = total ? got / total : 0;

  const issues: string[] = [];
  let formatting = 30;
  if (pages !== undefined && pages > MAX_PAGES) { formatting -= 10; issues.push(`The CV runs to ${pages} pages; ATS and recruiters prefer ${MAX_PAGES} at most`); }
  if (!cv.header.email) { formatting -= 3; issues.push("No email on the CV: add it in the profile"); }
  if (!cv.header.phone) { formatting -= 3; issues.push("No phone number on the CV: add it in the profile"); }

  const keywordPoints = Math.round(30 * coverage);
  const missing = results.filter((r) => !r.found).map((r) => r.term);
  const missingCritical = results.filter((r) => !r.found && r.critical).map((r) => r.term);
  if (coverage < 0.8) issues.push(`Keyword coverage is ${Math.round(coverage * 100)}%, under the 80% target. Missing: ${missing.join(", ")}`);
  if (missingCritical.length) issues.push(`Critical keywords missing: ${missingCritical.join(", ")}. If the user has the experience, add a fact for it (a gap card); the CV never claims it without one`);

  const bullets = [...cv.experience, ...cv.projects].flatMap((x) => x.bullets);
  const metric = bullets.filter((b) => /\d/.test(b)).length;
  const evidence = Math.min(20, metric * 4);
  if (metric < 4) issues.push(`Only ${metric} bullet${metric === 1 ? "" : "s"} carry a number. Use the facts that have real numbers`);

  const years = experienceSummary(listEntries(db))?.years;
  let summary = 0;
  if (cv.summary.length) summary += 5;
  else issues.push("There is no summary");
  const hasYears = /\b\d{1,2}\+?\s+years?\b/i.test(text.summary);
  if (hasYears) summary += 5;
  else if (years && years >= 1) issues.push(`The summary does not state the years of experience (your roles add up to ${years}+ years)`);
  if (results.some((r) => r.found && r.where.includes("summary"))) summary += 5;
  else if (cv.summary.length) issues.push("The summary uses none of the posting's keywords");
  if (cv.header.headline) summary += 5;
  else issues.push("There is no headline under the name");

  const availableProjects = listEntries(db, "project").filter((e) => db.prepare("SELECT 1 FROM facts WHERE entry_id = ? LIMIT 1").get(e.id)).length;
  const want = Math.min(2, availableProjects);
  if (cv.projects.length < want) issues.push(`Only ${cv.projects.length} of your ${availableProjects} projects are on the CV; include the ${want} most relevant`);

  const parts = { formatting: Math.max(0, formatting), keywords: keywordPoints, evidence, summary };
  const score = parts.formatting + parts.keywords + parts.evidence + parts.summary;
  void all;
  return { score, parts, coverage: Math.round(coverage * 100) / 100, keywords: results, missing, issues };
}

export function saveCvScore(db: DB, documentId: number, s: CvScore, actor: Actor): void {
  db.prepare("INSERT INTO cv_scores (document_id, score, detail) VALUES (?, ?, ?) ON CONFLICT(document_id) DO UPDATE SET score = excluded.score, detail = excluded.detail, scored_at = datetime('now')").run(documentId, s.score, JSON.stringify(s));
  logEvent(db, actor, "cv_scored", getDocument(db, documentId)?.jobId ?? null, { documentId, score: s.score });
}

export function getCvScore(db: DB, documentId: number): CvScore | undefined {
  const r = db.prepare("SELECT detail, scored_at FROM cv_scores WHERE document_id = ?").get(documentId) as { detail: string; scored_at: string } | undefined;
  return r ? { ...(JSON.parse(r.detail) as CvScore), scoredAt: r.scored_at } : undefined;
}
