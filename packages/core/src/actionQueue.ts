import type { DB } from "./db.js";
import { numberTokens } from "./documents.js";
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
  /** Where a "draft this gap for me" request stands. Set by the user's button and by the agent's answer. */
  draft?: GapDraftState;
  /** "Improve my wording": the user's own text, and Claude's better version once it is ready. */
  polish?: GapPolishState;
}

export interface GapPolishState {
  status: "requested" | "ready";
  /** What the user wrote. The improved wording may not add anything to it. */
  original: string;
  /** For a bullet that needs a number: what the user typed (the number and what it counts). The reworded bullet must carry it. */
  numbers?: string;
  polished?: string;
  note?: string;
}

export interface GapDraftState {
  status: "requested" | "ready" | "none";
  requestedAt?: string;
  /** The agent's note: what the draft rests on, or why nothing could be drafted. */
  note?: string;
}

interface GapRow { id: number; job_id: number | null; payload: string }

const openGaps = (db: DB): GapRow[] => db.prepare("SELECT id, job_id, payload FROM action_queue WHERE kind = 'gap' AND status = 'open' ORDER BY id").all() as GapRow[];

/**
 * The user asks Claude to draft the answer to one gap (actionId), every open gap of a job (jobId) or every open gap.
 * Only gaps that are not already waiting are marked. Returns how many were marked.
 */
export function requestGapDrafts(db: DB, scope: { actionId?: number; jobId?: number }, actor: Actor): number {
  requireHuman(actor, "gap drafts");
  let n = 0;
  db.transaction(() => {
    for (const r of openGaps(db)) {
      if (scope.actionId !== undefined && r.id !== scope.actionId) continue;
      if (scope.jobId !== undefined && r.job_id !== scope.jobId) continue;
      const p = JSON.parse(r.payload) as GapReport & { metric?: boolean };
      if (p.metric) continue; // a bullet that needs a number: only the user can supply it
      if (p.draft?.status === "requested") continue;
      p.draft = { status: "requested", requestedAt: new Date().toISOString() };
      db.prepare("UPDATE action_queue SET payload = ? WHERE id = ?").run(JSON.stringify(p), r.id);
      n++;
    }
    if (scope.actionId !== undefined && n === 0 && !openGaps(db).some((r) => r.id === scope.actionId)) throw new Error(`Gap ${scope.actionId} not found or already resolved`);
    if (n > 0) logEvent(db, actor, "gap_draft_requested", scope.jobId ?? null, { ...scope, count: n });
  })();
  return n;
}

/** The user gives up waiting: the request is cleared and the box stays as it was. */
export function cancelGapDrafts(db: DB, scope: { actionId?: number; jobId?: number }, actor: Actor): number {
  requireHuman(actor, "gap drafts");
  let n = 0;
  for (const r of openGaps(db)) {
    if (scope.actionId !== undefined && r.id !== scope.actionId) continue;
    if (scope.jobId !== undefined && r.job_id !== scope.jobId) continue;
    const p = JSON.parse(r.payload) as GapReport;
    if (p.draft?.status !== "requested") continue;
    delete p.draft;
    db.prepare("UPDATE action_queue SET payload = ? WHERE id = ?").run(JSON.stringify(p), r.id);
    n++;
  }
  return n;
}

/** What the agent has been asked to draft. */
export function listGapDraftRequests(db: DB): { actionId: number; jobId: number | null; requirement: string; detail?: string; importance?: string; closestFactIds: number[] }[] {
  return openGaps(db).flatMap((r) => {
    const p = JSON.parse(r.payload) as GapReport;
    if (p.draft?.status !== "requested") return [];
    return [{ actionId: r.id, jobId: r.job_id, requirement: p.requirement, detail: p.detail, importance: p.importance, closestFactIds: p.closestFactIds ?? [] }];
  });
}

/**
 * The agent answers a draft request: a draft the user can confirm, or null when nothing in the user's facts backs the
 * requirement. Nothing is saved as a fact; the user still presses the save button.
 */
export function submitGapDraft(db: DB, actionId: number, draft: { kind: FactKind; text: string; dateRange?: string } | null, note: string | undefined, closestFactIds: number[] | undefined, actor: Actor): void {
  const r = openGaps(db).find((g) => g.id === actionId);
  if (!r) throw new Error(`Gap ${actionId} not found or already resolved`);
  const p = JSON.parse(r.payload) as GapReport;
  if (p.draft?.status !== "requested") throw new Error(`Nobody asked for a draft of gap ${actionId}`);
  if (draft) {
    // A draft may only repeat numbers the user's own facts or the requirement already contain.
    const known = new Set(numberTokens((db.prepare("SELECT text FROM facts").all() as { text: string }[]).map((f) => f.text).join(" ") + " " + p.requirement));
    const extra = numberTokens(draft.text).filter((n) => !known.has(n));
    if (extra.length) throw new Error(`The draft contains ${extra.map((n) => `"${n}"`).join(", ")}, which no saved fact has. Use only numbers from the user's facts`);
    p.suggestedFact = draft;
    p.draft = { status: "ready", note };
  } else {
    p.draft = { status: "none", note: note ?? "Nothing in your facts backs this." };
  }
  if (closestFactIds) p.closestFactIds = closestFactIds;
  db.prepare("UPDATE action_queue SET payload = ? WHERE id = ?").run(JSON.stringify(p), actionId);
  logEvent(db, actor, "gap_draft_submitted", r.job_id, { id: actionId, drafted: draft !== null });
}

/** A job asks for something none of the user's facts support. The agent reports it and never fills it in. */
export function reportGap(db: DB, jobId: number, gap: GapReport, actor: Actor = "agent"): number {
  // The same requirement reported again (for example by a second tailoring run) refreshes the open
  // card instead of adding a duplicate.
  const wanted = gap.requirement.trim().toLowerCase();
  const open = db.prepare("SELECT id, payload FROM action_queue WHERE kind = 'gap' AND status = 'open' AND job_id = ?").all(jobId) as { id: number; payload: string }[];
  const same = open.find((r) => String(JSON.parse(r.payload).requirement ?? "").trim().toLowerCase() === wanted);
  if (same) {
    const old = JSON.parse(same.payload) as { draft?: unknown; suggestedFact?: unknown };
    // A refresh keeps a draft request that is still waiting, and keeps a ready draft unless the new report brings its own.
    const merged = { ...gap, ...(old.draft ? { draft: old.draft } : {}), ...((old as { polish?: unknown }).polish ? { polish: (old as { polish?: unknown }).polish } : {}), ...(!gap.suggestedFact && old.suggestedFact ? { suggestedFact: old.suggestedFact } : {}) };
    db.prepare("UPDATE action_queue SET payload = ? WHERE id = ?").run(JSON.stringify(merged), same.id);
    logEvent(db, actor, "gap_refreshed", jobId, { id: same.id });
    return same.id;
  }
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

const MAX_GAP_TEXT = 1000;

/** The user asks Claude to word what they wrote better. The text is kept with the request, so Claude works from exactly that. */
export function requestGapPolish(db: DB, actionId: number, text: string, actor: Actor): void {
  requireHuman(actor, "gap wording");
  const original = text.trim();
  if (!original) throw new Error("Write something first");
  if (original.length > MAX_GAP_TEXT) throw new Error(`Keep it to ${MAX_GAP_TEXT} characters`);
  const r = openGaps(db).find((g) => g.id === actionId);
  if (!r) throw new Error(`Gap ${actionId} not found or already resolved`);
  const p = JSON.parse(r.payload) as GapReport;
  p.polish = { status: "requested", original };
  db.prepare("UPDATE action_queue SET payload = ? WHERE id = ?").run(JSON.stringify(p), actionId);
  logEvent(db, actor, "gap_polish_requested", r.job_id, { id: actionId });
}

/** The user keeps their own wording, or has taken Claude's: the polish state is cleared either way. */
export function clearGapPolish(db: DB, actionId: number, actor: Actor): void {
  requireHuman(actor, "gap wording");
  const r = openGaps(db).find((g) => g.id === actionId);
  if (!r) return;
  const p = JSON.parse(r.payload) as GapReport;
  if (!p.polish) return;
  delete p.polish;
  db.prepare("UPDATE action_queue SET payload = ? WHERE id = ?").run(JSON.stringify(p), actionId);
}

export function listGapPolishRequests(db: DB): { actionId: number; jobId: number | null; requirement: string; original: string; numbers?: string }[] {
  return openGaps(db).flatMap((r) => {
    const p = JSON.parse(r.payload) as GapReport;
    return p.polish?.status === "requested" ? [{ actionId: r.id, jobId: r.job_id, requirement: p.requirement, original: p.polish.original, ...(p.polish.numbers ? { numbers: p.polish.numbers } : {}) }] : [];
  });
}

/**
 * The user gave the number for a bullet that needs one. The bullet and the number are kept with the request; Claude rewords the bullet
 * so it carries the number, and the user checks the result before it is saved.
 */
export function requestMetricPolish(db: DB, actionId: number, numbers: string, actor: Actor): void {
  requireHuman(actor, "metric wording");
  const n = numbers.trim();
  if (!/\d/.test(n)) throw new Error("Give the number first: a count, a percentage, a time or a size");
  if (n.length > 300) throw new Error("Keep it to 300 characters");
  const r = openGaps(db).find((g) => g.id === actionId);
  if (!r) throw new Error(`Request ${actionId} not found or already resolved`);
  const p = JSON.parse(r.payload) as GapReport & { metric?: boolean; suggestedFact?: { text: string } };
  if (!p.metric || !p.suggestedFact) throw new Error(`Action ${actionId} is not a number request`);
  p.polish = { status: "requested", original: p.suggestedFact.text, numbers: n };
  db.prepare("UPDATE action_queue SET payload = ? WHERE id = ?").run(JSON.stringify(p), actionId);
  logEvent(db, actor, "metric_polish_requested", r.job_id, { id: actionId });
}

/** Claude's better wording. It may fix grammar, clarity and tone, and nothing else: no new facts, numbers or length. */
export function submitGapPolish(db: DB, actionId: number, polished: string, note: string | undefined, actor: Actor): void {
  const r = openGaps(db).find((g) => g.id === actionId);
  if (!r) throw new Error(`Gap ${actionId} not found or already resolved`);
  const p = JSON.parse(r.payload) as GapReport;
  if (p.polish?.status !== "requested") throw new Error(`Nobody asked for better wording on gap ${actionId}`);
  const text = polished.trim();
  const original = p.polish.original;
  if (!text) throw new Error("The improved wording is empty");
  if (text.length > MAX_GAP_TEXT) throw new Error(`Keep it to ${MAX_GAP_TEXT} characters`);
  if (text.length > Math.max(300, (original.length + (p.polish.numbers?.length ?? 0)) * 2.5)) throw new Error("The improved wording is much longer than what the user wrote. Improve it, do not add to it");
  const given = p.polish.numbers;
  const said = new Set(numberTokens(given ? `${original} ${given}` : original));
  const extra = numberTokens(text).filter((n) => !said.has(n));
  if (extra.length) throw new Error(`The improved wording contains ${extra.map((n) => `"${n}"`).join(", ")}, which the user did not write. Use only numbers they gave you`);
  if (given) {
    const absent = numberTokens(given).filter((n) => !numberTokens(text).includes(n));
    if (absent.length) throw new Error(`The reworded bullet must carry the number the user gave (${absent.map((n) => `"${n}"`).join(", ")}). Work it in naturally`);
  }
  p.polish = { status: "ready", original, ...(given ? { numbers: given } : {}), polished: text, note };
  db.prepare("UPDATE action_queue SET payload = ? WHERE id = ?").run(JSON.stringify(p), actionId);
  logEvent(db, actor, "gap_polish_submitted", r.job_id, { id: actionId });
}
