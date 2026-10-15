import type { DB } from "./db.js";
import { addFact, deleteFact, listFacts, type Fact, type FactKind } from "./facts.js";
import { requireCountry } from "./countries.js";
import { logEvent } from "./jobs.js";
import { EMPLOYMENT_TYPES, getPreferences, getProfile, requireHuman, type EmploymentType, type Profile } from "./profile.js";
import type { Actor } from "./states.js";

export { EMPLOYMENT_TYPES, type EmploymentType };

export const ENTRY_KINDS = ["work", "project", "education"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export const ENTRY_WEIGHTS = ["normal", "always", "lead"] as const;
/** lead: always on the CV and listed before the others of its kind. always: always on the CV. normal: the agent decides. */
export type EntryWeight = (typeof ENTRY_WEIGHTS)[number];

export interface EntryInput {
  kind: EntryKind;
  /** Job title, project name, or degree. */
  title: string;
  /** Employer or school. */
  organization?: string;
  location?: string;
  /** YYYY or YYYY-MM. */
  startDate?: string;
  endDate?: string;
  isCurrent?: boolean;
  /** For education: GPA or other detail. For a project: where it lives. */
  note?: string;
  weight?: EntryWeight;
  /** Country the work was for, matched against the user's country priority. */
  country?: string;
  /** How the work was done, matched against the user's employment priority. Work entries only. */
  employmentType?: EmploymentType;
}

export interface CvEntry extends Required<Pick<EntryInput, "kind" | "title">> {
  id: number;
  organization?: string;
  location?: string;
  startDate?: string;
  endDate?: string;
  isCurrent: boolean;
  note?: string;
  weight: EntryWeight;
  country?: string;
  employmentType?: EmploymentType;
  sortOrder: number;
}

const DATE = /^\d{4}(-(0[1-9]|1[0-2]))?$/;
const BULLET_KIND: Record<EntryKind, FactKind> = { work: "experience", project: "achievement", education: "education" };

const toEntry = (r: any): CvEntry => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  organization: r.organization ?? undefined,
  location: r.location ?? undefined,
  startDate: r.start_date ?? undefined,
  endDate: r.end_date ?? undefined,
  isCurrent: r.is_current === 1,
  note: r.note ?? undefined,
  weight: r.weight,
  country: r.country ?? undefined,
  employmentType: r.employment_type ?? undefined,
  sortOrder: r.sort_order,
});

function clean(e: EntryInput): EntryInput {
  const t = (v?: string) => v?.trim() || undefined;
  const out = {
    ...e,
    title: e.title.trim(),
    organization: t(e.organization),
    location: t(e.location),
    startDate: t(e.startDate),
    endDate: e.isCurrent ? undefined : t(e.endDate),
    note: t(e.note),
    country: t(e.country) ? requireCountry(t(e.country)!) : undefined,
    employmentType: e.employmentType || undefined,
    weight: e.weight ?? ("normal" as EntryWeight),
  };
  if (!ENTRY_WEIGHTS.includes(out.weight)) throw new Error("Weight must be normal, always or lead");
  if (!ENTRY_KINDS.includes(out.kind)) throw new Error("Entry kind must be work, project or education");
  if (out.employmentType && !EMPLOYMENT_TYPES.includes(out.employmentType)) throw new Error("Employment type must be full_time, part_time, contract or freelance");
  if (!out.title) throw new Error("An entry needs a title");
  for (const d of [out.startDate, out.endDate]) {
    if (d !== undefined && !DATE.test(d)) throw new Error(`Dates look like 2024 or 2024-03, not "${d}"`);
  }
  if (out.startDate && out.endDate && out.endDate < out.startDate) throw new Error("The end date is before the start date");
  return out;
}

export function listEntries(db: DB, kind?: EntryKind): CvEntry[] {
  const order = "CASE kind WHEN 'work' THEN 0 WHEN 'project' THEN 1 ELSE 2 END, sort_order, id";
  const rows = kind
    ? db.prepare(`SELECT * FROM cv_entries WHERE kind = ? ORDER BY ${order}`).all(kind)
    : db.prepare(`SELECT * FROM cv_entries ORDER BY ${order}`).all();
  return rows.map(toEntry);
}

export function getEntry(db: DB, id: number): CvEntry | null {
  const r = db.prepare("SELECT * FROM cv_entries WHERE id = ?").get(id);
  return r ? toEntry(r) : null;
}

export function addEntry(db: DB, input: EntryInput, actor: Actor): number {
  requireHuman(actor, "CV entries");
  const e = clean(input);
  const next = (db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM cv_entries WHERE kind = ?").get(e.kind) as { n: number }).n;
  const info = db
    .prepare(
      `INSERT INTO cv_entries (kind, title, organization, location, start_date, end_date, is_current, note, weight, country, employment_type, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(e.kind, e.title, e.organization ?? null, e.location ?? null, e.startDate ?? null, e.endDate ?? null, e.isCurrent ? 1 : 0, e.note ?? null, e.weight!, e.country ?? null, e.employmentType ?? null, next);
  const id = Number(info.lastInsertRowid);
  logEvent(db, actor, "cv_entry_added", null, { id, kind: e.kind });
  return id;
}

export function updateEntry(db: DB, id: number, input: EntryInput, actor: Actor): void {
  requireHuman(actor, "CV entries");
  const e = clean(input);
  const existing = getEntry(db, id);
  if (!existing) throw new Error(`Entry ${id} not found`);
  if (existing.kind !== e.kind) throw new Error("An entry's kind cannot change");
  db.prepare(
    `UPDATE cv_entries SET title = ?, organization = ?, location = ?, start_date = ?, end_date = ?, is_current = ?, note = ?, weight = ?, country = ?, employment_type = ? WHERE id = ?`,
  ).run(e.title, e.organization ?? null, e.location ?? null, e.startDate ?? null, e.endDate ?? null, e.isCurrent ? 1 : 0, e.note ?? null, e.weight!, e.country ?? null, e.employmentType ?? null, id);
  logEvent(db, actor, "cv_entry_updated", null, { id });
}

export function moveEntry(db: DB, id: number, direction: "up" | "down", actor: Actor): void {
  requireHuman(actor, "CV entries");
  db.transaction(() => {
    const entry = getEntry(db, id);
    if (!entry) throw new Error(`Entry ${id} not found`);
    const ids = listEntries(db, entry.kind).map((x) => x.id);
    const i = ids.indexOf(id);
    const j = direction === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    ids.forEach((eid, n) => db.prepare("UPDATE cv_entries SET sort_order = ? WHERE id = ?").run(n + 1, eid));
  })();
}

/** Deletes an entry and its bullets. Refused if a saved document cites any bullet, so old CVs stay traceable. */
export function deleteEntry(db: DB, id: number, actor: Actor): void {
  requireHuman(actor, "CV entries");
  db.transaction(() => {
    if (!getEntry(db, id)) throw new Error(`Entry ${id} not found`);
    const bullets = db.prepare("SELECT id FROM facts WHERE entry_id = ?").all(id) as { id: number }[];
    for (const b of bullets) deleteFact(db, b.id, actor);
    db.prepare("DELETE FROM cv_entries WHERE id = ?").run(id);
    logEvent(db, actor, "cv_entry_deleted", null, { id });
  })();
}

/** Adds a bullet to an entry. Bullets are facts, so the usual truthfulness rules apply to them. */
export function addBullet(db: DB, entryId: number, text: string, actor: Actor): number {
  requireHuman(actor, "CV entries");
  const entry = getEntry(db, entryId);
  if (!entry) throw new Error(`Entry ${entryId} not found`);
  return addFact(db, { kind: BULLET_KIND[entry.kind], text, entryId }, actor);
}

/**
 * Makes a skill group match the given list: adds new skills, removes missing ones.
 * A skill cited by a saved document cannot be removed.
 */
export const SKILL_LEVELS = ["beginner", "intermediate", "advanced", "expert"] as const;
export type SkillLevel = (typeof SKILL_LEVELS)[number];

/** "Python:advanced" is the skill Python at the level advanced. A level is optional. */
export function parseSkillItem(raw: string): { text: string; level?: SkillLevel } {
  const m = /^(.*\S)\s*:\s*(beginner|intermediate|advanced|expert)$/i.exec(raw.trim());
  return m ? { text: m[1]!.trim(), level: m[2]!.toLowerCase() as SkillLevel } : { text: raw.trim() };
}

export function setSkillGroup(db: DB, group: string, items: string[], actor: Actor): void {
  requireHuman(actor, "skills");
  const g = group.trim();
  if (!g || g.length > 60) throw new Error("A skill group needs a name of up to 60 characters");
  const wanted = new Map<string, { text: string; level?: SkillLevel }>();
  for (const raw of items) {
    const it = parseSkillItem(raw);
    if (it.text && !wanted.has(it.text.toLowerCase())) wanted.set(it.text.toLowerCase(), it);
  }
  db.transaction(() => {
    const current = db.prepare("SELECT id, text, skill_level AS level FROM facts WHERE kind = 'skill' AND skill_group = ?").all(g) as { id: number; text: string; level: string | null }[];
    const have = new Map(current.map((c) => [c.text.toLowerCase(), c]));
    for (const c of current) if (!wanted.has(c.text.toLowerCase())) deleteFact(db, c.id, actor);
    for (const [key, it] of wanted) {
      const existing = have.get(key);
      if (!existing) {
        const id = addFact(db, { kind: "skill", text: it.text, skillGroup: g }, actor);
        if (it.level) db.prepare("UPDATE facts SET skill_level = ? WHERE id = ?").run(it.level, id);
      } else if ((existing.level ?? undefined) !== it.level) {
        // The level is whatever the box says: remove ":advanced" and the level is cleared.
        db.prepare("UPDATE facts SET skill_level = ? WHERE id = ?").run(it.level ?? null, existing.id);
      }
    }
  })();
}

export interface CvMaterialEntry extends CvEntry {
  bullets: { id: number; text: string }[];
}

export interface ExperienceSummary {
  /** Whole years of work, from the dated work entries. Gaps are not counted and overlapping jobs count once. */
  years: number;
  /** The same in months, so a page that wants decimals or "3.5" can be answered. */
  months: number;
  /** The month the earliest dated work entry started. */
  since: string;
  /** Work entries with no start date: they are left out of the count. */
  undatedEntries: number;
}

export interface CvMaterial {
  /** How long the user has worked, calculated here so nobody has to do the arithmetic. Not present when no work entry has a date. */
  experience?: ExperienceSummary;
  profile: Profile | null;
  /** The user's own words about how their CVs should be built. Follow them. */
  guidance?: string;
  /** Countries best first. Among entries of the same weight, those from earlier countries come first. */
  countryPriority: string[];
  /** Employment types best first (full_time, part_time, contract, freelance). After country, earlier types come first; entries with no type come last. */
  employmentPriority: string[];
  entries: CvMaterialEntry[];
  skills: { group: string; skills: { id: number; text: string; level?: SkillLevel }[] }[];
  /** The level to give a skill that has none, when a site asks for one. Not set means ask the user. */
  defaultSkillLevel?: SkillLevel;
  /** Facts that belong to no entry and are not skills, for use in a summary. */
  otherFacts: { id: number; kind: FactKind; text: string }[];
}

const monthIndex = (d: string, edge: "start" | "end"): number | undefined => {
  const m = /^(\d{4})(?:-(\d{2}))?/.exec(d);
  if (!m) return undefined;
  // A date with only a year is read the cautious way: a start counts from December, an end from January.
  const month = m[2] ? Number(m[2]) : edge === "start" ? 12 : 1;
  return Number(m[1]) * 12 + (month - 1);
};

/**
 * Months covered by the dated work entries, counted once however many roles overlap, with gaps left out.
 * A current role runs to the month of `now`.
 */
export function experienceSummary(entries: Pick<CvEntry, "kind" | "startDate" | "endDate" | "isCurrent">[], now: Date = new Date()): ExperienceSummary | undefined {
  const nowIdx = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const work = entries.filter((e) => e.kind === "work");
  const spans: [number, number][] = [];
  let earliest: number | undefined;
  for (const e of work) {
    const s = e.startDate ? monthIndex(e.startDate, "start") : undefined;
    if (s === undefined) continue;
    const end = e.isCurrent ? nowIdx : e.endDate ? monthIndex(e.endDate, "end") ?? s : s;
    spans.push([s, Math.max(s, Math.min(end, nowIdx))]);
    earliest = earliest === undefined ? s : Math.min(earliest, s);
  }
  if (!spans.length || earliest === undefined) return undefined;
  spans.sort((a, b) => a[0] - b[0]);
  let months = 0;
  let [curStart, curEnd] = spans[0]!;
  for (const [s, e] of spans.slice(1)) {
    if (s <= curEnd + 1) curEnd = Math.max(curEnd, e);
    else { months += curEnd - curStart + 1; [curStart, curEnd] = [s, e]; }
  }
  months += curEnd - curStart + 1;
  const since = `${Math.floor(earliest / 12)}-${String((earliest % 12) + 1).padStart(2, "0")}`;
  return { years: Math.floor(months / 12), months, since, undatedEntries: work.filter((e) => !e.startDate).length };
}

/** Everything a CV can be built from, for one job (or none). Facts reserved for other jobs are left out. */
export function getCvMaterial(db: DB, forJob: number | null): CvMaterial {
  const facts: Fact[] = listFacts(db, { forJob });
  const entries = listEntries(db).map((e) => ({
    ...e,
    bullets: facts.filter((f) => f.entryId === e.id).map((f) => ({ id: f.id, text: f.text })),
  }));
  const groups = new Map<string, { id: number; text: string; level?: SkillLevel }[]>();
  for (const f of facts) {
    if (f.kind === "skill" && f.skillGroup) {
      const list = groups.get(f.skillGroup) ?? [];
      list.push({ id: f.id, text: f.text, level: f.skillLevel });
      groups.set(f.skillGroup, list);
    }
  }
  return {
    experience: experienceSummary(entries),
    profile: getProfile(db),
    guidance: getPreferences(db)?.cvGuidance,
    defaultSkillLevel: getPreferences(db)?.defaultSkillLevel,
    countryPriority: getPreferences(db)?.countryPriority ?? [],
    employmentPriority: getPreferences(db)?.employmentPriority ?? [],
    entries,
    skills: [...groups].map(([group, skills]) => ({ group, skills })),
    otherFacts: facts
      .filter((f) => f.entryId === undefined && !(f.kind === "skill" && f.skillGroup))
      .map((f) => ({ id: f.id, kind: f.kind, text: f.text })),
  };
}

export interface CvImport {
  entries: (EntryInput & { bullets?: string[] })[];
  skills?: { group: string; items: string[] }[];
}

/** One-off load of an existing CV into an empty database. The user reviews and edits it afterwards. */
export function importCv(db: DB, data: CvImport, actor: Actor): { entries: number; bullets: number; skills: number } {
  requireHuman(actor, "CV entries");
  return db.transaction(() => {
    if (listEntries(db).length > 0) throw new Error("The CV already has entries. Import only into an empty CV.");
    let bullets = 0;
    let skills = 0;
    for (const { bullets: b, ...entry } of data.entries) {
      const id = addEntry(db, entry, actor);
      for (const text of b ?? []) {
        addBullet(db, id, text, actor);
        bullets++;
      }
    }
    for (const g of data.skills ?? []) {
      setSkillGroup(db, g.group, g.items, actor);
      skills += g.items.length;
    }
    return { entries: data.entries.length, bullets, skills };
  })();
}
