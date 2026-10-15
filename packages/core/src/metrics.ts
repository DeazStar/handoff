import type { DB } from "./db.js";
import { queueAction, resolveAction } from "./actionQueue.js";
import { getFacts, updateFact } from "./facts.js";
import { logEvent } from "./jobs.js";
import { requireHuman } from "./profile.js";
import type { Actor } from "./states.js";

interface Candidate {
  id: number;
  kind: "experience" | "achievement";
  text: string;
  entry_id: number;
  title: string;
  organization: string | null;
  is_current: number;
  start_date: string | null;
}

/** Bullets of the user's roles and projects that carry no number. They are the ones an ATS and a recruiter find weakest. */
function bulletsWithoutNumber(db: DB): Candidate[] {
  return db
    .prepare(
      `SELECT f.id, f.kind, f.text, f.entry_id, e.title, e.organization, e.is_current, e.start_date
       FROM facts f JOIN cv_entries e ON e.id = f.entry_id
       WHERE e.kind IN ('work','project') AND f.kind IN ('experience','achievement') AND f.job_id IS NULL
         AND f.text NOT GLOB '*[0-9]*'
         AND NOT EXISTS (SELECT 1 FROM action_queue a WHERE a.kind = 'gap' AND json_extract(a.payload, '$.metricFactId') = f.id)`,
    )
    .all() as Candidate[];
}

export function countBulletsWithoutNumber(db: DB): number {
  return bulletsWithoutNumber(db).length;
}

/**
 * Turns bullets that have no number into cards, a few at a time (most used on saved CVs first, then current roles, then recent ones),
 * so the queue does not fill up. A bullet the user said they have no number for is never asked about again.
 */
export function requestMetricCards(db: DB, limit: number, actor: Actor): number {
  requireHuman(actor, "metric cards");
  const candidates = bulletsWithoutNumber(db);
  if (!candidates.length) return 0;
  const used = new Map<number, number>();
  for (const r of db.prepare("SELECT fact_ids_used FROM documents WHERE kind = 'cv'").all() as { fact_ids_used: string }[]) {
    for (const id of JSON.parse(r.fact_ids_used) as number[]) used.set(id, (used.get(id) ?? 0) + 1);
  }
  const ranked = candidates.sort((a, b) => (used.get(b.id) ?? 0) - (used.get(a.id) ?? 0) || b.is_current - a.is_current || (b.start_date ?? "").localeCompare(a.start_date ?? "") || a.id - b.id);
  const pick = ranked.slice(0, Math.max(1, Math.min(limit, 20)));
  db.transaction(() => {
    for (const c of pick) {
      queueAction(
        db,
        "gap",
        null,
        {
          requirement: "Add a real number to this bullet",
          detail: `${c.title}${c.organization ? " at " + c.organization : ""}. Recruiters and ATS read a number as proof: users, a percentage, time saved, how many services. Only a number you can stand behind.`,
          importance: "nice_to_have",
          metric: true,
          metricFactId: c.id,
          suggestedFact: { kind: c.kind, text: c.text },
        },
        actor,
      );
    }
  })();
  logEvent(db, actor, "metric_cards_requested", null, { count: pick.length });
  return pick.length;
}

/** The user rewrote the bullet with a real number. The fact is updated for every job and the card is done. */
export function confirmMetric(db: DB, actionId: number, text: string, actor: Actor): void {
  requireHuman(actor, "facts");
  db.transaction(() => {
    const a = db.prepare("SELECT kind, status, payload FROM action_queue WHERE id = ?").get(actionId) as { kind: string; status: string; payload: string } | undefined;
    const p = a ? (JSON.parse(a.payload) as { metricFactId?: number }) : undefined;
    if (!a || a.kind !== "gap" || p?.metricFactId === undefined) throw new Error(`Action ${actionId} is not a number request`);
    if (a.status !== "open") throw new Error(`Action ${actionId} is already resolved`);
    const t = text.trim();
    if (!/\d/.test(t)) throw new Error("Add the number: a count, a percentage, a time or a size, in the bullet");
    if (t.length > 600) throw new Error("Keep the bullet to 600 characters");
    const fact = getFacts(db, [p.metricFactId])[0];
    if (!fact) throw new Error("That bullet no longer exists");
    updateFact(db, fact.id, { kind: fact.kind, text: t, dateRange: fact.dateRange, tags: fact.tags, sourceNote: fact.sourceNote, jobId: fact.jobId, entryId: fact.entryId, skillGroup: fact.skillGroup }, actor);
    resolveAction(db, actionId, "done", actor);
    logEvent(db, actor, "metric_added", null, { factId: fact.id });
  })();
}
