import type { DB } from "./db.js";
import { addFact, type FactKind, type NewFact } from "./facts.js";
import { logEvent } from "./jobs.js";
import { requireHuman } from "./profile.js";
import type { Actor } from "./states.js";

export const ACTION_KINDS = [
  "approve_email",
  "signup_needed",
  "captcha",
  "sensitive_question",
  "confirm_submit",
  "out_of_range",
  "verify_unclear",
  "follow_up",
  "gap",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export function queueAction(
  db: DB,
  kind: ActionKind,
  jobId: number | null,
  payload: unknown = {},
  actor: Actor = "agent",
): number {
  const info = db
    .prepare("INSERT INTO action_queue (kind, job_id, payload) VALUES (?, ?, ?)")
    .run(kind, jobId, JSON.stringify(payload));
  const id = Number(info.lastInsertRowid);
  logEvent(db, actor, "action_queued", jobId, { id, kind });
  return id;
}

export function listOpenActions(db: DB): unknown[] {
  return db.prepare("SELECT * FROM action_queue WHERE status = 'open' ORDER BY created_at, id").all();
}

/** Only a human can resolve an action; the agent queues, the human decides. */
export function resolveAction(db: DB, id: number, status: "done" | "dismissed", actor: Actor): void {
  if (actor !== "human") throw new Error("Only a human can resolve queue items");
  const info = db
    .prepare("UPDATE action_queue SET status = ?, resolved_at = datetime('now') WHERE id = ? AND status = 'open'")
    .run(status, id);
  if (info.changes === 0) throw new Error(`Action ${id} not found or already resolved`);
  logEvent(db, actor, "action_resolved", null, { id, status });
}

export interface GapReport {
  /** What the job asks for, in its own words. */
  requirement: string;
  /** Why this is a gap, and how close the user's facts come. */
  detail?: string;
  importance?: "required" | "nice_to_have";
  /** Existing facts that partly cover it. */
  closestFactIds?: number[];
  /** A conservative draft the user can confirm, edit or reject. Never saved on its own. */
  suggestedFact?: { kind: FactKind; text: string; dateRange?: string };
}

/** A job asks for something none of the user's facts support. The agent reports it and never fills it in. */
export function reportGap(db: DB, jobId: number, gap: GapReport, actor: Actor = "agent"): number {
  return queueAction(db, "gap", jobId, gap, actor);
}

/**
 * The user confirms a gap by stating the fact themselves (possibly starting from the agent's
 * draft). The fact is saved and the gap resolved in one transaction. scope "job" keeps the
 * fact usable for this job only; "general" adds it to the user's profile for every job.
 */
export function confirmGap(
  db: DB,
  actionId: number,
  fact: Omit<NewFact, "jobId">,
  scope: "job" | "general",
  actor: Actor,
): number {
  requireHuman(actor, "facts");
  return db.transaction(() => {
    const a = db.prepare("SELECT job_id, kind, status FROM action_queue WHERE id = ?").get(actionId) as
      | { job_id: number | null; kind: string; status: string }
      | undefined;
    if (!a || a.kind !== "gap") throw new Error(`Action ${actionId} is not a gap`);
    if (a.status !== "open") throw new Error(`Action ${actionId} is already resolved`);
    if (scope === "job" && a.job_id === null) throw new Error("This gap has no job to reserve the fact for");
    const factId = addFact(
      db,
      {
        ...fact,
        jobId: scope === "job" ? a.job_id! : undefined,
        sourceNote: fact.sourceNote ?? `Confirmed by the user from a gap on job ${a.job_id}`,
      },
      actor,
    );
    resolveAction(db, actionId, "done", actor);
    return factId;
  })();
}
