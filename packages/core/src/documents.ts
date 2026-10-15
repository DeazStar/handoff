import type { DB } from "./db.js";
import { getFacts } from "./facts.js";
import { logEvent } from "./jobs.js";
import { requireHuman } from "./profile.js";
import type { Actor } from "./states.js";

/**
 * A document is a list of blocks (a sentence or bullet each). A "claim" block must cite
 * the facts it relies on. A "boilerplate" block (greeting, sign-off) cites nothing and
 * therefore may not contain digits, so a claim cannot be smuggled in as boilerplate.
 * Contact details are added when the file is rendered, from the profile, not as blocks.
 */
export interface Block {
  text: string;
  factIds: number[];
  kind?: "claim" | "boilerplate";
  /** Number tokens the server itself derived (such as years of experience from the user's dated roles), so they need no fact. */
  allowNumbers?: string[];
}

export interface NewDocument {
  jobId: number | null;
  kind: "cv" | "cover" | "email";
  path: string;
  blocks: Block[];
  /** For a CV: the plan it was built from. */
  plan?: unknown;
  /** Facts used that are not in a block, such as skills. */
  extraFactIds?: number[];
}

export class ProvenanceError extends Error {
  constructor(public problems: string[]) {
    super(`Document rejected:\n- ${problems.join("\n- ")}`);
  }
}

const NUMBER = /\d[\d.,]*%?/g;

/**
 * Numbers in a text as whole tokens: "50,000" and "50000" are the same token, "5" is not
 * found inside "50000", and "40%" is a different token from "40" (a percentage is a
 * different claim from a count).
 */
export function numberTokens(text: string): string[] {
  return (text.match(NUMBER) ?? []).map((t) =>
    t.replace(/[.,]+$/, "").replace(/,(?=\d{3}(?!\d))/g, ""),
  );
}

/** Returns every problem found; an empty list means the document is acceptable. */
export function checkProvenance(db: DB, blocks: Block[], jobId: number | null = null): string[] {
  const problems: string[] = [];
  if (blocks.length === 0) return ["Document has no content"];

  const wanted = [...new Set(blocks.flatMap((b) => b.factIds))];
  const found = new Map(getFacts(db, wanted).map((f) => [f.id, f]));

  blocks.forEach((b, i) => {
    const label = `Block ${i + 1} ("${b.text.slice(0, 40)}")`;
    const numbers = numberTokens(b.text).filter((n) => !(b.allowNumbers ?? []).includes(n));

    if ((b.kind ?? "claim") === "boilerplate") {
      if (b.factIds.length > 0) problems.push(`${label}: boilerplate must not cite facts`);
      if (numbers.length > 0) problems.push(`${label}: boilerplate must not contain numbers`);
      return;
    }
    if (b.factIds.length === 0) {
      problems.push(`${label}: claim cites no fact`);
      return;
    }
    const missing = b.factIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      problems.push(`${label}: unknown fact id(s) ${missing.join(", ")}`);
      return;
    }
    const foreign = b.factIds.filter((id) => {
      const f = found.get(id)!;
      return f.jobId !== undefined && f.jobId !== jobId;
    });
    if (foreign.length > 0) {
      problems.push(`${label}: fact(s) ${foreign.join(", ")} are reserved for a different job`);
      return;
    }
    const source = b.factIds.map((id) => `${found.get(id)!.text} ${found.get(id)!.dateRange ?? ""}`).join(" ");
    const allowed = new Set(numberTokens(source));
    for (const n of numbers) {
      if (!allowed.has(n)) problems.push(`${label}: "${n}" does not appear in the cited facts`);
    }
  });
  return problems;
}

export interface SavedDocument {
  id: number;
  jobId: number | null;
  kind: NewDocument["kind"];
  version: number;
  path: string;
  factIds: number[];
  blocks: Block[];
  plan?: unknown;
  generatedAt: string;
}

const toDocument = (r: any): SavedDocument => ({
  id: r.id,
  jobId: r.job_id,
  kind: r.kind,
  version: r.version,
  path: r.path,
  factIds: JSON.parse(r.fact_ids_used),
  blocks: JSON.parse(r.content),
  plan: r.plan ? JSON.parse(r.plan) : undefined,
  generatedAt: r.generated_at,
});

export function getDocument(db: DB, id: number): SavedDocument | null {
  const r = db.prepare("SELECT * FROM documents WHERE id = ?").get(id);
  return r ? toDocument(r) : null;
}

/** Removes a saved document's record. Only the user can. Returns the stored path so the caller can remove the file. */
export function deleteDocument(db: DB, id: number, actor: Actor): string {
  requireHuman(actor, "documents");
  const doc = getDocument(db, id);
  if (!doc) throw new Error(`Document ${id} not found`);
  db.transaction(() => {
    db.prepare("DELETE FROM documents WHERE id = ?").run(id);
    logEvent(db, actor, "document_deleted", doc.jobId, { id, kind: doc.kind, version: doc.version });
  })();
  return doc.path;
}

export function listDocuments(db: DB, jobId: number | null): SavedDocument[] {
  return db
    .prepare("SELECT * FROM documents WHERE job_id IS ? ORDER BY kind, version")
    .all(jobId)
    .map(toDocument);
}

/** The version number the next saved document of this kind for this job will get. */
export function nextDocumentVersion(db: DB, jobId: number | null, kind: NewDocument["kind"]): number {
  const last = db.prepare("SELECT MAX(version) AS v FROM documents WHERE job_id IS ? AND kind = ?").get(jobId, kind) as { v: number | null };
  return (last.v ?? 0) + 1;
}

export function saveDocument(db: DB, doc: NewDocument, actor: Actor): { id: number; version: number } {
  const problems = checkProvenance(db, doc.blocks, doc.jobId);
  if (problems.length > 0) throw new ProvenanceError(problems);

  const factIds = [...new Set([...doc.blocks.flatMap((b) => b.factIds), ...(doc.extraFactIds ?? [])])].sort((a, b) => a - b);
  return db.transaction(() => {
    const last = db
      .prepare("SELECT MAX(version) AS v FROM documents WHERE job_id IS ? AND kind = ?")
      .get(doc.jobId, doc.kind) as { v: number | null };
    const version = (last.v ?? 0) + 1;
    const info = db
      .prepare("INSERT INTO documents (job_id, kind, version, path, fact_ids_used, content, plan) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(doc.jobId, doc.kind, version, doc.path, JSON.stringify(factIds), JSON.stringify(doc.blocks), doc.plan === undefined ? null : JSON.stringify(doc.plan));
    const id = Number(info.lastInsertRowid);
    logEvent(db, actor, "document_saved", doc.jobId, { id, kind: doc.kind, version });
    return { id, version };
  })();
}
