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
}

export interface NewFact {
  kind: FactKind;
  text: string;
  dateRange?: string;
  tags?: string[];
  sourceNote?: string;
}

const toFact = (r: any): Fact => ({
  id: r.id,
  kind: r.kind,
  text: r.text,
  dateRange: r.date_range ?? undefined,
  tags: JSON.parse(r.tags),
  sourceNote: r.source_note ?? undefined,
});

export function listFacts(db: DB, kind?: FactKind): Fact[] {
  const rows = kind
    ? db.prepare("SELECT * FROM facts WHERE kind = ? ORDER BY id").all(kind)
    : db.prepare("SELECT * FROM facts ORDER BY id").all();
  return rows.map(toFact);
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
    .prepare("INSERT INTO facts (kind, text, date_range, tags, source_note) VALUES (?, ?, ?, ?, ?)")
    .run(f.kind, f.text.trim(), f.dateRange ?? null, JSON.stringify(f.tags ?? []), f.sourceNote ?? null);
  const id = Number(info.lastInsertRowid);
  logEvent(db, actor, "fact_added", null, { id });
  return id;
}

export function updateFact(db: DB, id: number, f: NewFact, actor: Actor): void {
  requireHuman(actor, "facts");
  if (!f.text.trim()) throw new Error("A fact needs text");
  const info = db
    .prepare("UPDATE facts SET kind = ?, text = ?, date_range = ?, tags = ?, source_note = ? WHERE id = ?")
    .run(f.kind, f.text.trim(), f.dateRange ?? null, JSON.stringify(f.tags ?? []), f.sourceNote ?? null, id);
  if (info.changes === 0) throw new Error(`Fact ${id} not found`);
  logEvent(db, actor, "fact_updated", null, { id });
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
