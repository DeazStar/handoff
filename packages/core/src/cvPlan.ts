import type { DB } from "./db.js";
import { checkProvenance, ProvenanceError, type Block } from "./documents.js";
import { getFacts, type Fact } from "./facts.js";
import { experienceSummary, getEntry, listEntries, type CvEntry, type EntryKind } from "./cv.js";
import { fillerIn } from "./writingLint.js";
import { getPreferences, getProfile } from "./profile.js";

/**
 * A plan says what goes on the CV and in what order. It says nothing about layout: fonts,
 * spacing, section order and page size belong to the renderer. A bullet is either a fact
 * number (use that fact's text word for word) or reworded text that cites its facts.
 */
export type BulletRef = number | { text: string; factIds: number[] };

export interface CvPlan {
  /** A short label under the name, such as "Backend-leaning Full-Stack Engineer". No seniority the user's real titles do not back. */
  headline?: string;
  /** One to three short sentences about who the user is, their experience and their skills; no first person, no results or numbers except "N years" (the server's own count). Each cites facts. */
  summary?: { text: string; factIds: number[] }[];
  /** Order here is the order on the page. Bullets must be facts of that entry. */
  experience?: { entryId: number; bullets: BulletRef[] }[];
  projects?: { entryId: number; bullets: BulletRef[] }[];
  education?: { entryId: number }[];
  /** A group name and which of its skills to show, in order. */
  skills?: { group: string; factIds: number[] }[];
}

/**
 * The order the user's rules require: entries that lead first, then by country priority (earlier
 * countries first; entries with no listed country last), then by employment type priority (same
 * way). The sort is stable, so ties keep their order.
 */
export function orderForCv<T extends { weight: string; country?: string; employmentType?: string }>(db: DB, list: T[]): T[] {
  const prefs = getPreferences(db);
  const countries = (prefs?.countryPriority ?? []).map((c) => c.toLowerCase());
  const types = prefs?.employmentPriority ?? [];
  const rankIn = (order: string[], v?: string) => (v ? order.indexOf(v.toLowerCase()) + 1 || order.length + 1 : order.length + 1);
  const key = (e: T) => [e.weight === "lead" ? 0 : 1, rankIn(countries, e.country), rankIn(types, e.employmentType)];
  return list
    .map((e, i) => ({ e, i, k: key(e) }))
    .sort((a, b) => a.k[0]! - b.k[0]! || a.k[1]! - b.k[1]! || a.k[2]! - b.k[2]! || a.i - b.i)
    .map((x) => x.e);
}

export interface ResolvedCv {
  header: { name: string; headline?: string; email?: string; phone?: string; location?: string; links: string[] };
  summary: string[];
  experience: { entry: CvEntry; bullets: string[] }[];
  projects: { entry: CvEntry; bullets: string[] }[];
  education: { entry: CvEntry }[];
  skills: { group: string; items: string[] }[];
}

const MAX_SUMMARY = 3;
const MAX_SUMMARY_WORDS = 30;
const MAX_HEADLINE = 60;
const FIRST_I = /\b(?:I|I['’](?:m|ve|d|ll)|myself)\b/;
const FIRST_MY = /\b(?:my|me|mine)\b/i;
const firstPerson = (t: string) => FIRST_I.exec(t)?.[0] ?? FIRST_MY.exec(t)?.[0];
const SENIORITY_WORDS = /\b(senior|sr|lead|staff|principal|head|director|chief|architect|manager|vp)\b/i;
const YEARS = /\b(\d{1,2})\+?\s+years?\b/gi;

/** An "N years" claim may use the years the server counted from the dated roles, and no more. Returns the allowed number tokens. */
export function yearsCheck(text: string, maxYears: number | undefined): { problems: string[]; allow: string[] } {
  const problems: string[] = [];
  const allow: string[] = [];
  for (const m of text.matchAll(YEARS)) {
    const claimed = Number(m[1]);
    if (maxYears === undefined) problems.push(`"${m[0]}" cannot be checked because your roles have no start dates`);
    else if (claimed > maxYears) problems.push(`"${m[0]}" is more than the ${maxYears} full years your dated roles add up to`);
    else allow.push(m[1]!);
  }
  return { problems, allow };
}

/** Problems with a summary beyond the facts check: voice, length, filler, and a years claim the server cannot back. */
export function summaryProblems(texts: string[], maxYears: number | undefined): { problems: string[]; allow: string[][] } {
  const problems: string[] = [];
  const allow: string[][] = [];
  texts.forEach((t, i) => {
    const n = `summary sentence ${i + 1}`;
    const person = firstPerson(t);
    if (person) problems.push(`${n}: a CV summary has no first person ("${person}"). Write "Backend engineer who..." and not "I lead..."`);
    const words = t.trim().split(/\s+/).length;
    if (words > MAX_SUMMARY_WORDS) problems.push(`${n}: ${words} words; keep each sentence under ${MAX_SUMMARY_WORDS}. Split it or cut it`);
    const filler = fillerIn(t);
    if (filler) problems.push(`${n}: "${filler}" is filler. Use the plain word or the result`);
    // Results and numbers belong in the bullets. The only number a summary may carry is the years of experience.
    if (/\d/.test(t.replace(YEARS, ""))) problems.push(`${n}: a summary has no numbers except years of experience. Put results and numbers in the bullets`);
    const yc = yearsCheck(t, maxYears);
    problems.push(...yc.problems.map((x) => `${n}: ${x}`));
    const ok = yc.allow;
    allow.push(ok);
  });
  return { problems, allow };
}

const WORD = /[a-z0-9]+/g;
const words = (t: string) => (t.toLowerCase().match(WORD) ?? []).filter((w) => w.length >= 3);

/** True when most of a summary sentence is copied from one bullet: the summary should say who the user is, not repeat the experience section. */
export function repeatsBullet(sentence: string, bullets: string[]): string | undefined {
  const s = new Set(words(sentence));
  if (s.size < 6) return undefined;
  return bullets.find((b) => {
    const bw = new Set(words(b));
    let shared = 0;
    for (const w of s) if (bw.has(w)) shared++;
    return shared / s.size >= 0.6;
  });
}

/** The headline is a label, not a claim: no digits, no first person, and no seniority word that none of the user's work titles carries. */
export function headlineProblems(headline: string, workTitles: string[]): string[] {
  const out: string[] = [];
  const h = headline.trim();
  if (!h) return ["the headline is empty"];
  if (h.length > MAX_HEADLINE) out.push(`the headline is ${h.length} characters; keep it under ${MAX_HEADLINE}`);
  if (/\d/.test(h)) out.push("the headline has digits; put numbers in the summary");
  if (firstPerson(h)) out.push("the headline has no first person");
  const seniority = SENIORITY_WORDS.exec(h);
  if (seniority && !workTitles.some((t) => new RegExp(`\\b${seniority[1]}\\b`, "i").test(t))) {
    out.push(`the headline says "${seniority[0]}", but none of your job titles does. Describe the work instead`);
  }
  return out;
}
const MAX_BULLETS = 40;

/**
 * Checks a plan against the user's entries and facts and turns it into what the renderer
 * needs. Throws ProvenanceError listing every problem. Nothing is written.
 */
export function prepareCv(
  db: DB,
  plan: CvPlan,
  jobId: number | null,
): { cv: ResolvedCv; blocks: Block[]; factIds: number[] } {
  const problems: string[] = [];
  const profile = getProfile(db);
  if (!profile) problems.push("The profile has no name yet (Settings, About you)");

  const wanted = new Set<number>();
  const note = (id: number) => wanted.add(id);
  for (const b of plan.summary ?? []) b.factIds.forEach(note);
  for (const s of [...(plan.experience ?? []), ...(plan.projects ?? [])]) {
    for (const b of s.bullets) typeof b === "number" ? note(b) : b.factIds.forEach(note);
  }
  for (const g of plan.skills ?? []) g.factIds.forEach(note);
  const facts = new Map<number, Fact>(getFacts(db, [...wanted]).map((f) => [f.id, f]));
  const visible = (f: Fact) => f.jobId === undefined || f.jobId === jobId;

  const groups: { label: string; blocks: Block[] }[] = [];
  const used = new Set<number>();

  let headline: string | undefined;
  if (plan.headline !== undefined) {
    const hp = headlineProblems(plan.headline, listEntries(db, "work").map((e) => e.title));
    problems.push(...hp.map((x) => `headline: ${x}`));
    if (!hp.length) headline = plan.headline.trim();
  }
  const summary: string[] = [];
  if ((plan.summary?.length ?? 0) > MAX_SUMMARY) problems.push(`summary has more than ${MAX_SUMMARY} sentences`);
  if (plan.summary?.length) {
    const years = experienceSummary(listEntries(db))?.years;
    const check = summaryProblems(plan.summary.map((b) => b.text), years);
    problems.push(...check.problems);
    const blocks = plan.summary.map((b, i) => ({ text: b.text, factIds: b.factIds, kind: "claim" as const, ...(check.allow[i]!.length ? { allowNumbers: check.allow[i] } : {}) }));
    groups.push({ label: "summary", blocks });
    summary.push(...blocks.map((b) => b.text));
    blocks.forEach((b) => b.factIds.forEach((id) => used.add(id)));
  }

  function bulletSection(label: string, kind: "work" | "project", list: CvPlan["experience"]) {
    const out: { entry: CvEntry; bullets: string[] }[] = [];
    const seen = new Set<number>();
    for (const item of list ?? []) {
      const entry = getEntry(db, item.entryId);
      const where = `${label} entry ${item.entryId}`;
      if (!entry) { problems.push(`${where}: no such entry`); continue; }
      if (entry.kind !== kind) { problems.push(`${where}: "${entry.title}" is a ${entry.kind} entry, not ${kind}`); continue; }
      if (seen.has(entry.id)) { problems.push(`${where}: listed twice`); continue; }
      seen.add(entry.id);
      if (item.bullets.length === 0) { problems.push(`${where} ("${entry.title}"): no bullets`); continue; }

      const blocks: Block[] = [];
      const texts: string[] = [];
      for (const ref of item.bullets) {
        const ids = typeof ref === "number" ? [ref] : ref.factIds;
        const foreign = ids.filter((id) => {
          const f = facts.get(id);
          return f && f.entryId !== entry.id;
        });
        if (foreign.length) {
          problems.push(`${where} ("${entry.title}"): fact(s) ${foreign.join(", ")} belong to a different entry`);
          continue;
        }
        if (typeof ref === "number") {
          const f = facts.get(ref);
          if (!f) { problems.push(`${where}: unknown fact ${ref}`); continue; }
          if (!visible(f)) { problems.push(`${where}: fact ${ref} is reserved for a different job`); continue; }
          blocks.push({ text: f.text, factIds: [ref], kind: "claim" });
          texts.push(f.text);
        } else {
          blocks.push({ text: ref.text, factIds: ref.factIds, kind: "claim" });
          texts.push(ref.text);
        }
        ids.forEach((id) => used.add(id));
      }
      groups.push({ label: `${where} ("${entry.title}")`, blocks });
      out.push({ entry, bullets: texts });
    }
    return out;
  }

  const experience = bulletSection("experience", "work", plan.experience);
  const projects = bulletSection("projects", "project", plan.projects);

  if (plan.summary?.length) {
    const bulletTexts = [...experience, ...projects].flatMap((x) => x.bullets);
    plan.summary.forEach((b, i) => {
      const copy = repeatsBullet(b.text, bulletTexts);
      if (copy) problems.push(`summary sentence ${i + 1}: repeats the bullet "${copy.slice(0, 60)}...". The summary says who you are, your experience and your skills in general terms; the detail stays in the bullets`);
    });
  }

  const priorityShown = getPreferences(db)?.countryPriority ?? [];
  const priority = priorityShown.map((c) => c.toLowerCase());
  const rank = (e: CvEntry) => (e.country ? priority.indexOf(e.country.toLowerCase()) + 1 || priority.length + 1 : priority.length + 1);
  const typesShown = getPreferences(db)?.employmentPriority ?? [];
  const typeRank = (e: CvEntry) => (e.employmentType ? typesShown.indexOf(e.employmentType) + 1 || typesShown.length + 1 : typesShown.length + 1);
  const typeName = (e: CvEntry) => (e.employmentType ? e.employmentType.replace("_", "-") : "no type");
  const named = (e: CvEntry) => `"${e.title}${e.organization ? " at " + e.organization : ""}"${e.country ? " (" + e.country + ")" : ""}`;

  // The user's weights are rules, not hints. Entries marked always or lead must be present, and
  // those marked lead must come before every entry that is not.
  function enforceWeights(label: string, kind: EntryKind, chosen: CvEntry[]) {
    const ids = new Set(chosen.map((c) => c.id));
    for (const e of listEntries(db, kind)) {
      if (e.weight !== "normal" && !ids.has(e.id)) {
        problems.push(`${label}: "${e.title}${e.organization ? " at " + e.organization : ""}" is marked ${e.weight === "lead" ? "lead with this" : "always include"} and must be in the CV`);
      }
    }
    if ((priority.length || typesShown.length) && kind !== "education") {
      const rest = chosen.filter((c) => c.weight !== "lead");
      for (let i = 0; i + 1 < rest.length; i++) {
        const a = rest[i]!, b = rest[i + 1]!;
        if (priority.length && rank(a) > rank(b)) {
          problems.push(`${label}: ${named(a)} is listed before ${named(b)}, but the user's country priority (${priorityShown.join(", ")}) puts the second first`);
        } else if (typesShown.length && rank(a) === rank(b) && typeRank(a) > typeRank(b)) {
          problems.push(`${label}: ${named(a)} (${typeName(a)}) is listed before ${named(b)} (${typeName(b)}), but with the same country the user's employment priority (${typesShown.map((t) => t.replace("_", "-")).join(", ")}) puts the second first`);
        }
      }
    }
    const firstOther = chosen.findIndex((c) => c.weight !== "lead");
    if (firstOther >= 0) {
      for (const late of chosen.slice(firstOther).filter((c) => c.weight === "lead")) {
        problems.push(`${label}: "${late.title}${late.organization ? " at " + late.organization : ""}" is marked lead with this and must come before "${chosen[firstOther]!.title}${chosen[firstOther]!.organization ? " at " + chosen[firstOther]!.organization : ""}"`);
      }
    }
  }

  const education: { entry: CvEntry }[] = [];
  for (const item of plan.education ?? []) {
    const entry = getEntry(db, item.entryId);
    if (!entry) problems.push(`education entry ${item.entryId}: no such entry`);
    else if (entry.kind !== "education") problems.push(`education entry ${item.entryId}: "${entry.title}" is a ${entry.kind} entry`);
    else if (education.some((e) => e.entry.id === entry.id)) problems.push(`education entry ${item.entryId}: listed twice`);
    else education.push({ entry });
  }

  enforceWeights("experience", "work", experience.map((x) => x.entry));
  enforceWeights("projects", "project", projects.map((x) => x.entry));
  enforceWeights("education", "education", education.map((x) => x.entry));

  const skills: { group: string; items: string[] }[] = [];
  for (const g of plan.skills ?? []) {
    const items: string[] = [];
    for (const id of g.factIds) {
      const f = facts.get(id);
      if (!f) problems.push(`skills "${g.group}": unknown fact ${id}`);
      else if (f.kind !== "skill" || f.skillGroup !== g.group) problems.push(`skills "${g.group}": fact ${id} ("${f.text}") is not in that group`);
      else if (!visible(f)) problems.push(`skills "${g.group}": fact ${id} is reserved for a different job`);
      else if (!items.includes(f.text)) { items.push(f.text); used.add(id); }
    }
    if (items.length) skills.push({ group: g.group, items });
  }

  for (const g of groups) {
    for (const p of checkProvenance(db, g.blocks, jobId)) problems.push(`${g.label}: ${p}`);
  }
  const blocks = groups.flatMap((g) => g.blocks);
  if (blocks.length > MAX_BULLETS) problems.push(`more than ${MAX_BULLETS} bullets in total; the CV would be too long`);
  if (!summary.length && !experience.length && !projects.length && !education.length && !skills.length) {
    problems.push("the plan has no content");
  }
  if (problems.length > 0) throw new ProvenanceError(problems);

  return {
    cv: {
      header: {
        name: profile!.fullName,
        headline,
        email: profile!.email,
        phone: profile!.phone,
        location: profile!.location,
        links: profile!.links,
      },
      summary,
      experience,
      projects,
      education,
      skills,
    },
    blocks,
    factIds: [...used].sort((a, b) => a - b),
  };
}
