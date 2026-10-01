import type { DB } from "./db.js";
import { getFacts } from "./facts.js";
import { logEvent } from "./jobs.js";
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
}

export interface NewDocument {
  jobId: number | null;
  kind: "cv" | "cover" | "email";
  path: string;
  blocks: Block[];
}

export class ProvenanceError extends Error {
  constructor(public problems: string[]) {
    super(`Document rejected:\n- ${problems.join("\n- ")}`);
  }
}

const NUMBER = /\d[\d.,]*%?/g;
const clean = (s: string) => s.replace(/[.,]+$/, "");

/** Returns every problem found; an empty list means the document is acceptable. */
export function checkProvenance(db: DB, blocks: Block[]): string[] {
  const problems: string[] = [];
  if (blocks.length === 0) return ["Document has no content"];

  const wanted = [...new Set(blocks.flatMap((b) => b.factIds))];
  const found = new Map(getFacts(db, wanted).map((f) => [f.id, f]));

  blocks.forEach((b, i) => {
    const label = `Block ${i + 1} ("${b.text.slice(0, 40)}")`;
    const numbers = (b.text.match(NUMBER) ?? []).map(clean);

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
    const source = b.factIds.map((id) => `${found.get(id)!.text} ${found.get(id)!.dateRange ?? ""}`).join(" ");
    for (const n of numbers) {
      if (!source.includes(n)) problems.push(`${label}: "${n}" does not appear in the cited facts`);
    }
  });
  return problems;
}

export function saveDocument(db: DB, doc: NewDocument, actor: Actor): { id: number; version: number } {
  const problems = checkProvenance(db, doc.blocks);
  if (problems.length > 0) throw new ProvenanceError(problems);

  const factIds = [...new Set(doc.blocks.flatMap((b) => b.factIds))].sort((a, b) => a - b);
  return db.transaction(() => {
    const last = db
      .prepare("SELECT MAX(version) AS v FROM documents WHERE job_id IS ? AND kind = ?")
      .get(doc.jobId, doc.kind) as { v: number | null };
    const version = (last.v ?? 0) + 1;
    const info = db
      .prepare("INSERT INTO documents (job_id, kind, version, path, fact_ids_used) VALUES (?, ?, ?, ?, ?)")
      .run(doc.jobId, doc.kind, version, doc.path, JSON.stringify(factIds));
    const id = Number(info.lastInsertRowid);
    logEvent(db, actor, "document_saved", doc.jobId, { id, kind: doc.kind, version });
    return { id, version };
  })();
}
