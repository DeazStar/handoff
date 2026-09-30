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
}

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

/** Inserts a job, or returns the existing id when the canonical URL or description already exists. */
export function addCandidateJob(db: DB, job: NewJob, actor: Actor = "agent"): { id: number; created: boolean } {
  const byUrl = db.prepare("SELECT id FROM jobs WHERE canonical_url = ?").get(job.canonicalUrl) as
    | { id: number }
    | undefined;
  if (byUrl) return { id: byUrl.id, created: false };
  if (job.descriptionHash) {
    const byHash = db
      .prepare("SELECT id FROM jobs WHERE description_hash = ? AND company_id IS ?")
      .get(job.descriptionHash, job.companyId ?? null) as { id: number } | undefined;
    if (byHash) return { id: byHash.id, created: false };
  }
  const info = db
    .prepare(
      `INSERT INTO jobs (company_id, source_id, title, url, canonical_url, location, remote, posted_at, description_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    );
  const id = Number(info.lastInsertRowid);
  logEvent(db, actor, "job_added", id, { url: job.url });
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
  })();
}
