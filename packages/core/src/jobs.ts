import type { DB } from "./db.js";
import { assertTransition, type Actor, type JobState } from "./states.js";

export interface NewJob {
  title: string;
  url: string;
  canonicalUrl: string;
  companyId?: number;
  sourceId?: number;
  location?: string;
  remote?: boolean;
  postedAt?: string;
  descriptionHash?: string;
  /** The posting's text, kept so later steps need not reopen the page. Untrusted: it came from the internet. */
  description?: string;
  /** Who the posting says posted it (a name or a role). */
  postedBy?: string;
  /** Where to apply, if different from the posting page. */
  applyUrl?: string;
  /** The user gave this link themselves. Such jobs do not use the discovery limit. */
  userProvided?: boolean;
}

export const MAX_DESCRIPTION = 60_000;

export function logEvent(
  db: DB,
  actor: Actor,
  type: string,
  jobId: number | null,
  detail: unknown = {},
): void {
  db.prepare("INSERT INTO events (actor, type, job_id, detail) VALUES (?, ?, ?, ?)").run(
    actor,
    type,
    jobId,
    JSON.stringify(detail),
  );
}

/** The id of a job already stored under this canonical URL, or the same description at the same company. */
export function findExistingJob(db: DB, job: NewJob): number | undefined {
  const byUrl = db.prepare("SELECT id FROM jobs WHERE canonical_url = ?").get(job.canonicalUrl) as
    | { id: number }
    | undefined;
  if (byUrl) return byUrl.id;
  if (job.descriptionHash) {
    const byHash = db
      .prepare("SELECT id FROM jobs WHERE description_hash = ? AND company_id IS ?")
      .get(job.descriptionHash, job.companyId ?? null) as { id: number } | undefined;
    if (byHash) return byHash.id;
  }
  return undefined;
}

/** Inserts a job, or returns the existing id when the canonical URL or description already exists. */
export function addCandidateJob(db: DB, job: NewJob, actor: Actor = "agent"): { id: number; created: boolean } {
  const existing = findExistingJob(db, job);
  if (existing !== undefined) return { id: existing, created: false };
  const info = db
    .prepare(
      `INSERT INTO jobs (company_id, source_id, title, url, canonical_url, location, remote, posted_at, description_hash, description, posted_by, apply_url, details_at, user_provided)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      job.companyId ?? null,
      job.sourceId ?? null,
      job.title,
      job.url,
      job.canonicalUrl,
      job.location ?? null,
      job.remote === undefined ? null : job.remote ? 1 : 0,
      job.postedAt ?? null,
      job.descriptionHash ?? null,
      job.description?.trim() ? job.description.trim().slice(0, MAX_DESCRIPTION) : null,
      job.postedBy?.trim().slice(0, 200) || null,
      job.applyUrl?.trim() || null,
      job.description?.trim() ? new Date().toISOString().slice(0, 19).replace("T", " ") : null,
      job.userProvided ? 1 : 0,
    );
  const id = Number(info.lastInsertRowid);
  logEvent(db, actor, "job_added", id, { url: job.url, ...(job.userProvided ? { userProvided: true } : {}) });
  return { id, created: true };
}

export function transitionJob(
  db: DB,
  jobId: number,
  to: JobState,
  actor: Actor,
  reason?: string,
): void {
  db.transaction(() => {
    const row = db.prepare("SELECT state FROM jobs WHERE id = ?").get(jobId) as
      | { state: JobState }
      | undefined;
    if (!row) throw new Error(`Job ${jobId} not found`);
    assertTransition(row.state, to, actor);
    db.prepare("UPDATE transition_guard SET job_id = ?, to_state = ?").run(jobId, to);
    db.prepare("UPDATE jobs SET state = ?, state_reason = ?, updated_at = datetime('now') WHERE id = ?").run(
      to,
      reason ?? null,
      jobId,
    );
    db.prepare("UPDATE transition_guard SET job_id = NULL, to_state = NULL").run();
    logEvent(db, actor, "state_changed", jobId, { from: row.state, to, reason });
    // A job nobody will apply to leaves no work waiting on the user: its open cards (form to check, CAPTCHA, gaps, drafts) are closed.
    if (to === "skipped" || to === "dead") {
      const closed = db.prepare("UPDATE action_queue SET status = 'dismissed', resolved_at = datetime('now') WHERE job_id = ? AND status = 'open'").run(jobId).changes;
      if (closed > 0) logEvent(db, actor, "actions_closed_with_job", jobId, { count: closed, to });
    }
  })();
}

/** Saves or replaces the posting text and who posted it, for a job found before this was kept. */
export function saveJobDetails(
  db: DB,
  jobId: number,
  d: { description: string; postedBy?: string; applyUrl?: string },
  actor: Actor,
): void {
  const text = d.description.trim();
  if (text.length < 20) throw new Error("The description is too short to be a job posting");
  const info = db
    .prepare("UPDATE jobs SET description = ?, posted_by = COALESCE(?, posted_by), apply_url = COALESCE(?, apply_url), details_at = datetime('now') WHERE id = ?")
    .run(text.slice(0, MAX_DESCRIPTION), d.postedBy?.trim().slice(0, 200) || null, d.applyUrl?.trim() || null, jobId);
  if (info.changes === 0) throw new Error(`Job ${jobId} not found`);
  logEvent(db, actor, "job_details_saved", jobId, { chars: Math.min(text.length, MAX_DESCRIPTION) });
}
