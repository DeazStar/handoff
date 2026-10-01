import type { DB } from "./db.js";
import { logEvent, transitionJob } from "./jobs.js";
import { queueAction } from "./actionQueue.js";
import type { Actor, JobState } from "./states.js";

export function upsertCompany(
  db: DB,
  c: { name: string; domain?: string; careersUrl?: string; notes?: string; discoveredVia?: string },
  actor: Actor,
): number {
  const name = c.name.trim();
  if (!name) throw new Error("A company needs a name");
  const domain = c.domain?.trim().toLowerCase().replace(/^www\./, "") || null;
  const existing = (
    domain
      ? db.prepare("SELECT id FROM companies WHERE domain = ?").get(domain)
      : db.prepare("SELECT id FROM companies WHERE lower(name) = lower(?) AND domain IS NULL").get(name)
  ) as { id: number } | undefined;
  if (existing) {
    if (c.careersUrl) {
      db.prepare("UPDATE companies SET careers_url = COALESCE(careers_url, ?) WHERE id = ?").run(c.careersUrl, existing.id);
    }
    return existing.id;
  }
  const info = db
    .prepare("INSERT INTO companies (name, domain, careers_url, notes, discovered_via) VALUES (?, ?, ?, ?, ?)")
    .run(name, domain, c.careersUrl ?? null, c.notes ?? null, c.discoveredVia ?? null);
  const id = Number(info.lastInsertRowid);
  logEvent(db, actor, "company_added", null, { id, name });
  return id;
}

export function upsertSource(
  db: DB,
  s: { kind: "google" | "jobsite" | "careers_page" | "email_contact"; name: string; url?: string },
  actor: Actor,
): number {
  const addedBy = actor === "human" ? "user" : "agent";
  db.prepare(
    `INSERT INTO sources (kind, name, url, added_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(kind, name) DO UPDATE SET url = COALESCE(sources.url, excluded.url)`,
  ).run(s.kind, s.name.trim(), s.url ?? null, addedBy);
  const row = db.prepare("SELECT id FROM sources WHERE kind = ? AND name = ?").get(s.kind, s.name.trim()) as { id: number };
  return row.id;
}

export interface Verification {
  result: "live" | "dead" | "unclear";
  httpStatus?: number;
  titleMatches?: boolean;
  applyPathFound?: boolean;
  evidence?: string;
  /** For unclear results: ask the user to look. The caller decides this from how good the match is. */
  queueIfUnclear?: boolean;
}

const bool = (b: boolean | undefined) => (b === undefined ? null : b ? 1 : 0);

/**
 * Records a link check and applies its consequence: live moves a found job to verified_live,
 * dead moves an unapplied job to dead, unclear changes nothing unless the caller asks for a queue item.
 */
export function recordVerification(
  db: DB,
  jobId: number,
  v: Verification,
  actor: Actor,
): { verificationId: number; state: JobState } {
  return db.transaction(() => {
    const job = db.prepare("SELECT state FROM jobs WHERE id = ?").get(jobId) as { state: JobState } | undefined;
    if (!job) throw new Error(`Job ${jobId} not found`);
    const info = db
      .prepare(
        "INSERT INTO verifications (job_id, http_status, title_matches, apply_path_found, result, evidence) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(jobId, v.httpStatus ?? null, bool(v.titleMatches), bool(v.applyPathFound), v.result, v.evidence ?? null);
    logEvent(db, actor, "verification_recorded", jobId, { result: v.result });

    let state = job.state;
    if (v.result === "live" && state === "found") {
      transitionJob(db, jobId, "verified_live", actor, "link verified live");
      state = "verified_live";
    } else if (v.result === "dead" && ["found", "verified_live", "matched", "materials_ready", "awaiting_approval"].includes(state)) {
      transitionJob(db, jobId, "dead", actor, "link no longer live");
      state = "dead";
    } else if (v.result === "unclear" && v.queueIfUnclear) {
      queueAction(db, "verify_unclear", jobId, { evidence: v.evidence }, actor);
    }
    return { verificationId: Number(info.lastInsertRowid), state };
  })();
}

/** Scores a verified job (0 to 10) with a reason, and moves it to matched. Re-scoring a matched job just updates the score. */
export function setMatch(db: DB, jobId: number, score: number, reason: string, actor: Actor): JobState {
  if (!Number.isFinite(score) || score < 0 || score > 10) throw new Error("score must be between 0 and 10");
  if (!reason.trim()) throw new Error("A match needs a reason");
  return db.transaction(() => {
    const job = db.prepare("SELECT state FROM jobs WHERE id = ?").get(jobId) as { state: JobState } | undefined;
    if (!job) throw new Error(`Job ${jobId} not found`);
    if (job.state !== "verified_live" && job.state !== "matched") {
      throw new Error(`Job must be verified live before it is matched (state: ${job.state})`);
    }
    db.prepare("UPDATE jobs SET match_score = ?, match_reason = ?, updated_at = datetime('now') WHERE id = ?").run(
      score,
      reason.trim(),
      jobId,
    );
    logEvent(db, actor, "match_set", jobId, { score });
    if (job.state === "verified_live") transitionJob(db, jobId, "matched", actor, `match ${score}/10`);
    return "matched" as JobState;
  })();
}
