import type { DB } from "./db.js";
import { checkProvenance, ProvenanceError, type Block } from "./documents.js";
import { getFacts, type Fact } from "./facts.js";
import { getEntry, listEntries, type CvEntry, type EntryKind } from "./cv.js";
import { getPreferences, getProfile } from "./profile.js";

/**
 * A plan says what goes on the CV and in what order. It says nothing about layout: fonts,
 * spacing, section order and page size belong to the renderer. A bullet is either a fact
 * number (use that fact's text word for word) or reworded text that cites its facts.
 */
export type BulletRef = number | { text: string; factIds: number[] };

export interface CvPlan {
  /** One to three sentences. Each must cite facts and its numbers must match them. */
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
  header: { name: string; email?: string; phone?: string; location?: string; links: string[] };
  summary: string[];
  experience: { entry: CvEntry; bullets: string[] }[];
  projects: { entry: CvEntry; bullets: string[] }[];
  education: { entry: CvEntry }[];
  skills: { group: string; items: string[] }[];
}

const MAX_SUMMARY = 3;
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

  const summary: string[] = [];
  if ((plan.summary?.length ?? 0) > MAX_SUMMARY) problems.push(`summary has more than ${MAX_SUMMARY} sentences`);
  if (plan.summary?.length) {
    const blocks = plan.summary.map((b) => ({ text: b.text, factIds: b.factIds, kind: "claim" as const }));
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
