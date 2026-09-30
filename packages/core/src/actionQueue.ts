import type { DB } from "./db.js";
import { logEvent } from "./jobs.js";
import type { Actor } from "./states.js";

export type ActionKind =
  | "approve_email"
  | "signup_needed"
  | "captcha"
  | "sensitive_question"
  | "confirm_submit"
  | "out_of_range"
  | "verify_unclear"
  | "follow_up";

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
