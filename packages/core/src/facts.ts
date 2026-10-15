import type { DB } from "./db.js";
import { logEvent } from "./jobs.js";
import { requireHuman } from "./profile.js";
import type { Actor } from "./states.js";

export const FACT_KINDS = ["experience", "skill", "achievement", "education", "cert"] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export interface Fact {
  id: number;
  kind: FactKind;
  text: string;
  dateRange?: string;
  tags: string[];
  sourceNote?: string;
  /** Set when the fact may only be used for one job; absent for general facts. */
  jobId?: number;
  /** The CV entry (job, project) this fact is a bullet of. */
  entryId?: number;
  /** For skills: the group they are listed under on the CV. */
  skillGroup?: string;
  /** For skills: how well the user says they know it. Only ever set by the user. */
  skillLevel?: "beginner" | "intermediate" | "advanced" | "expert";
}

export interface NewFact {
  kind: FactKind;
  text: string;
  dateRange?: string;
  tags?: string[];
  sourceNote?: string;
  jobId?: number;
  entryId?: number;
  skillGroup?: string;
}

const toFact = (r: any): Fact => ({
  id: r.id,
  kind: r.kind,
  text: r.text,
  dateRange: r.date_range ?? undefined,
  tags: JSON.parse(r.tags),
  sourceNote: r.source_note ?? undefined,
  jobId: r.job_id ?? undefined,
  entryId: r.entry_id ?? undefined,
  skillGroup: r.skill_group ?? undefined,
  skillLevel: r.skill_level ?? undefined,
});

/**
 * forJob undefined: every fact (the user's own view).
 * forJob null: general facts only.
 * forJob N: general facts plus the ones reserved for job N.
 */
export function listFacts(db: DB, opts: { kind?: FactKind; forJob?: number | null } = {}): Fact[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.kind) {
    where.push("kind = ?");
    args.push(opts.kind);
  }
  if (opts.forJob === null) where.push("job_id IS NULL");
  else if (opts.forJob !== undefined) {
    where.push("(job_id IS NULL OR job_id = ?)");
    args.push(opts.forJob);
  }
  const sql = `SELECT * FROM facts ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id`;
  return db.prepare(sql).all(...args).map(toFact);
}

export function getFacts(db: DB, ids: number[]): Fact[] {
  if (ids.length === 0) return [];
  const marks = ids.map(() => "?").join(",");
  return db.prepare(`SELECT * FROM facts WHERE id IN (${marks})`).all(...ids).map(toFact);
}

export function addFact(db: DB, f: NewFact, actor: Actor): number {
  requireHuman(actor, "facts");
  if (!f.text.trim()) throw new Error("A fact needs text");
  const info = db
    .prepare("INSERT INTO facts (kind, text, date_range, tags, source_note, job_id, entry_id, skill_group) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(f.kind, f.text.trim(), f.dateRange ?? null, JSON.stringify(f.tags ?? []), f.sourceNote ?? null, f.jobId ?? null, f.entryId ?? null, f.skillGroup ?? null);
  const id = Number(info.lastInsertRowid);
  logEvent(db, actor, "fact_added", f.jobId ?? null, { id, jobOnly: f.jobId !== undefined });
  return id;
}

export function updateFact(db: DB, id: number, f: NewFact, actor: Actor): void {
  requireHuman(actor, "facts");
  if (!f.text.trim()) throw new Error("A fact needs text");
  const info = db
    .prepare("UPDATE facts SET kind = ?, text = ?, date_range = ?, tags = ?, source_note = ?, job_id = ?, entry_id = ?, skill_group = ? WHERE id = ?")
    .run(f.kind, f.text.trim(), f.dateRange ?? null, JSON.stringify(f.tags ?? []), f.sourceNote ?? null, f.jobId ?? null, f.entryId ?? null, f.skillGroup ?? null, id);
  if (info.changes === 0) throw new Error(`Fact ${id} not found`);
  logEvent(db, actor, "fact_updated", null, { id });
}

/** Turns a job-only fact into a general one, once the user decides it should be reused. */
export function makeFactGeneral(db: DB, id: number, actor: Actor): void {
  requireHuman(actor, "facts");
  const info = db.prepare("UPDATE facts SET job_id = NULL WHERE id = ?").run(id);
  if (info.changes === 0) throw new Error(`Fact ${id} not found`);
  logEvent(db, actor, "fact_made_general", null, { id });
}

/** A fact already cited by a saved document cannot be deleted, so old documents stay traceable. */
export function deleteFact(db: DB, id: number, actor: Actor): void {
  requireHuman(actor, "facts");
  const used = db
    .prepare("SELECT COUNT(*) AS n FROM documents, json_each(documents.fact_ids_used) WHERE json_each.value = ?")
    .get(id) as { n: number };
  if (used.n > 0) throw new Error(`Fact ${id} is cited by ${used.n} saved document(s) and cannot be deleted`);
  const info = db.prepare("DELETE FROM facts WHERE id = ?").run(id);
  if (info.changes === 0) throw new Error(`Fact ${id} not found`);
  logEvent(db, actor, "fact_deleted", null, { id });
}
