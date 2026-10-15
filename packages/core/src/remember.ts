import type { DB } from "./db.js";
import { setStandardAnswer } from "./application.js";
import { queueAction } from "./actionQueue.js";
import { numberTokens } from "./documents.js";
import { addFact, FACT_KINDS, type FactKind } from "./facts.js";
import { logEvent } from "./jobs.js";
import { requireHuman } from "./profile.js";
import type { Actor } from "./states.js";

/**
 * Something the user said in chat that is worth keeping. The agent uses it at once and proposes saving it; nothing is stored until the
 * user clicks, because the agent has no right to put words in the user's mouth. `original` is what the user said, `polished` is the
 * same thing worded well. The polished version may not contain a number the user did not say.
 */
export type Proposal =
  | { type: "answer"; label: string; original: string; polished: string }
  | { type: "fact"; kind: FactKind; original: string; polished: string; entryId?: number };

const MAX_ANSWER = 2000;
const MAX_FACT = 600;

export function proposeRemember(db: DB, jobId: number | null, p: Proposal, actor: Actor): { actionId: number; alreadyOpen: boolean } {
  const original = p.original?.trim();
  const polished = p.polished?.trim();
  const max = p.type === "answer" ? MAX_ANSWER : MAX_FACT;
  if (!original || !polished) throw new Error("Give both what the user said (original) and the improved wording (polished)");
  if (original.length > max || polished.length > max) throw new Error(`Keep it to ${max} characters`);
  if (polished.length > Math.max(300, original.length * 2.5)) throw new Error("The improved wording is much longer than what the user said. Improve it, do not add to it");
  const said = new Set(numberTokens(original));
  const extra = numberTokens(polished).filter((n) => !said.has(n));
  if (extra.length) throw new Error(`The improved wording contains ${extra.map((n) => `"${n}"`).join(", ")}, which the user did not say. Use only numbers they gave you`);

  if (p.type === "answer") {
    const label = p.label?.trim();
    if (!label || label.length > 200) throw new Error("An answer needs the question it answers (up to 200 characters)");
    const known = db.prepare("SELECT answer FROM standard_answers WHERE lower(label) = lower(?)").get(label) as { answer: string } | undefined;
    if (known && known.answer.trim().toLowerCase() === polished.toLowerCase()) throw new Error("That answer is already saved");
    const open = db.prepare("SELECT id FROM action_queue WHERE kind = 'sensitive_question' AND status = 'open' AND lower(json_extract(payload, '$.proposal.label')) = lower(?)").get(label) as { id: number } | undefined;
    if (open) return { actionId: open.id, alreadyOpen: true };
    return { actionId: queueAction(db, "sensitive_question", jobId, { proposal: { type: "answer", label, original, polished } }, actor), alreadyOpen: false };
  }

  if (!FACT_KINDS.includes(p.kind)) throw new Error(`kind must be one of ${FACT_KINDS.join(", ")}`);
  if (p.entryId !== undefined && !db.prepare("SELECT 1 FROM cv_entries WHERE id = ?").get(p.entryId)) throw new Error(`CV entry ${p.entryId} not found`);
  if (db.prepare("SELECT 1 FROM facts WHERE lower(text) = lower(?) AND job_id IS NULL").get(polished)) throw new Error("That fact is already saved");
  const open = db.prepare("SELECT id FROM action_queue WHERE kind = 'sensitive_question' AND status = 'open' AND lower(json_extract(payload, '$.proposal.polished')) = lower(?)").get(polished) as { id: number } | undefined;
  if (open) return { actionId: open.id, alreadyOpen: true };
  return { actionId: queueAction(db, "sensitive_question", jobId, { proposal: { type: "fact", kind: p.kind, original, polished, entryId: p.entryId } }, actor), alreadyOpen: false };
}

/** The user's click: save the proposal as worded, as they said it, or as they edited it. */
export function acceptProposal(db: DB, actionId: number, choice: { use?: "polished" | "original" | "text"; text?: string }, actor: Actor): { saved: "answer" | "fact" } {
  requireHuman(actor, "saved answers");
  return db.transaction(() => {
    const row = db.prepare("SELECT payload FROM action_queue WHERE id = ? AND kind = 'sensitive_question' AND status = 'open'").get(actionId) as { payload: string } | undefined;
    const proposal = row ? (JSON.parse(row.payload).proposal as Proposal | undefined) : undefined;
    if (!row || !proposal) throw new Error(`There is no open proposal ${actionId}`);
    const text = (choice.use === "original" ? proposal.original : choice.use === "text" ? choice.text ?? "" : proposal.polished).trim();
    const max = proposal.type === "answer" ? MAX_ANSWER : MAX_FACT;
    if (!text || text.length > max) throw new Error(`The text must have words, up to ${max} characters`);
    if (proposal.type === "answer") {
      setStandardAnswer(db, proposal.label, text, actor);
      // A question card waiting for this same answer is done too.
      db.prepare("UPDATE action_queue SET status = 'done', resolved_at = datetime('now') WHERE kind = 'sensitive_question' AND status = 'open' AND lower(json_extract(payload, '$.question')) = lower(?)").run(proposal.label);
    } else {
      addFact(db, { kind: proposal.kind, text, entryId: proposal.entryId, sourceNote: "told to the agent in chat, confirmed by the user" }, actor);
    }
    db.prepare("UPDATE action_queue SET status = 'done', resolved_at = datetime('now') WHERE id = ?").run(actionId);
    logEvent(db, actor, "proposal_accepted", null, { type: proposal.type, used: choice.use ?? "polished" });
    return { saved: proposal.type };
  })();
}
