import { REMOTE_SCOPES, SPONSORSHIPS, type RemoteScope, type Sponsorship } from "./priority.js";
import type { DB } from "./db.js";
import { addCandidateJob, findExistingJob, logEvent, transitionJob, type NewJob } from "./jobs.js";
import { queueAction } from "./actionQueue.js";
import { canonicalizeUrl } from "./normalize.js";
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
export interface JobSignals {
  remoteScope?: RemoteScope;
  sponsorship?: Sponsorship;
  /** The posting's own words, or the register that lists the company. Required with confirmed or likely. */
  sponsorshipEvidence?: string;
}

export function setMatch(db: DB, jobId: number, score: number, reason: string, actor: Actor, signals: JobSignals = {}): JobState {
  if (!Number.isFinite(score) || score < 0 || score > 10) throw new Error("score must be between 0 and 10");
  if (!reason.trim()) throw new Error("A match needs a reason");
  if (signals.remoteScope !== undefined && !REMOTE_SCOPES.includes(signals.remoteScope)) throw new Error("remoteScope must be worldwide, open_to_me, closed or unclear");
  if (signals.sponsorship !== undefined && !SPONSORSHIPS.includes(signals.sponsorship)) throw new Error("sponsorship must be confirmed, likely or unknown");
  const evidence = signals.sponsorshipEvidence?.trim().slice(0, 500);
  if ((signals.sponsorship === "confirmed" || signals.sponsorship === "likely") && !evidence) {
    throw new Error("Say where the sponsorship signal comes from: quote the posting, or name the register");
  }
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
    if (signals.remoteScope !== undefined) db.prepare("UPDATE jobs SET remote_scope = ? WHERE id = ?").run(signals.remoteScope, jobId);
    if (signals.sponsorship !== undefined) {
      db.prepare("UPDATE jobs SET sponsorship = ?, sponsorship_evidence = ? WHERE id = ?").run(signals.sponsorship, signals.sponsorship === "unknown" ? null : evidence, jobId);
    }
    logEvent(db, actor, "match_set", jobId, { score, ...signals });
    if (job.state === "verified_live") transitionJob(db, jobId, "matched", actor, `match ${score}/10`);
    return "matched" as JobState;
  })();
}

export interface SourceRow {
  id: number;
  kind: string;
  name: string;
  url?: string;
  addedBy: "user" | "agent";
  enabled: boolean;
}

/** User-added, enabled sources are the ones the agent is told to search. */
export function listSources(db: DB): SourceRow[] {
  return db
    .prepare("SELECT id, kind, name, url, added_by, enabled FROM sources ORDER BY added_by DESC, name")
    .all()
    .map((r: any) => ({ id: r.id, kind: r.kind, name: r.name, url: r.url ?? undefined, addedBy: r.added_by, enabled: r.enabled === 1 }));
}

export function setSourceEnabled(db: DB, id: number, enabled: boolean, actor: Actor): void {
  if (actor !== "human") throw new Error("Only the user can turn sources on or off");
  const info = db.prepare("UPDATE sources SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  if (info.changes === 0) throw new Error(`Source ${id} not found`);
  logEvent(db, actor, "source_toggled", null, { id, enabled });
}

/** How much of today's discovery budget is used. "Today" is the user's local day. */
export function discoveryBudget(db: DB): { limit: number; addedToday: number; remaining: number } {
  const limit =
    (db.prepare("SELECT daily_discovery_limit AS n FROM preferences WHERE id = 1").get() as { n: number } | undefined)?.n ?? 10;
  const addedToday = (
    db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE date(found_at, 'localtime') = date('now', 'localtime')")
      .get() as { n: number }
  ).n;
  return { limit, addedToday, remaining: Math.max(0, limit - addedToday) };
}

/**
 * Records how to apply to a job. If the apply form is behind a sign-in, the user is asked
 * to sign up (the agent never does this) and the job is left waiting.
 */
export function setRoute(
  db: DB,
  jobId: number,
  route: "form" | "email" | "none",
  opts: { requiresSignin?: boolean; applyUrl?: string },
  actor: Actor,
): void {
  db.transaction(() => {
    const job = db.prepare("SELECT url FROM jobs WHERE id = ?").get(jobId) as { url: string } | undefined;
    if (!job) throw new Error(`Job ${jobId} not found`);
    db.prepare("UPDATE jobs SET route = ?, updated_at = datetime('now') WHERE id = ?").run(route, jobId);
    logEvent(db, actor, "route_set", jobId, { route, requiresSignin: opts.requiresSignin ?? false });
    if (route === "form" && opts.requiresSignin) {
      const target = opts.applyUrl ?? job.url;
      let site = target;
      try { site = new URL(target).hostname; } catch {}
      queueAction(db, "signup_needed", jobId, { site, applyUrl: target }, actor);
    }
  })();
}

export class BudgetError extends Error {}

/**
 * The agent's way to add a job. Once today's discovery limit is used, only jobs that are
 * already stored come back (they cost nothing); anything new is refused.
 */
export function addCandidateJobWithinBudget(db: DB, job: NewJob, actor: Actor): { id: number; created: boolean } {
  return db.transaction(() => {
    const budget = discoveryBudget(db);
    if (budget.remaining === 0 && findExistingJob(db, job) === undefined) {
      throw new BudgetError(
        `Daily discovery limit reached (${budget.addedToday} of ${budget.limit} jobs added today). ` +
          `Stop searching for today. The user can raise the limit in Settings.`,
      );
    }
    return addCandidateJob(db, job, actor);
  })();
}

export const SKIP_REASONS = ["dead", "closed", "not_a_match", "blocked", "repost", "other"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** Remembers a link that was opened and rejected, so it is not opened again. Does not use budget. */
export function logSkippedCandidate(
  db: DB,
  c: { url: string; reason: SkipReason; detail?: string; sourceId?: number },
  actor: Actor,
): void {
  const canonicalUrl = canonicalizeUrl(c.url);
  const host = new URL(canonicalUrl).hostname;
  db.prepare(
    `INSERT INTO skipped_candidates (canonical_url, host, reason, detail, source_id) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(canonical_url) DO UPDATE SET reason = excluded.reason, detail = excluded.detail,
       source_id = COALESCE(excluded.source_id, skipped_candidates.source_id), at = datetime('now')`,
  ).run(canonicalUrl, host, c.reason, c.detail ?? null, c.sourceId ?? null);
  logEvent(db, actor, "candidate_skipped", null, { host, reason: c.reason });
}

export type CandidateStatus =
  | { known: "job"; jobId: number; state: JobState; canonicalUrl: string }
  | { known: "skipped"; reason: SkipReason; detail?: string; at: string; canonicalUrl: string }
  | { known: null; canonicalUrl: string };

/** Is this link already a job, or already rejected? Cheap, so check it before opening a page. */
export function checkCandidate(db: DB, url: string): CandidateStatus {
  const canonicalUrl = canonicalizeUrl(url);
  const job = db.prepare("SELECT id, state FROM jobs WHERE canonical_url = ?").get(canonicalUrl) as
    | { id: number; state: JobState }
    | undefined;
  if (job) return { known: "job", jobId: job.id, state: job.state, canonicalUrl };
  const k = db.prepare("SELECT reason, detail, at FROM skipped_candidates WHERE canonical_url = ?").get(canonicalUrl) as
    | { reason: SkipReason; detail: string | null; at: string }
    | undefined;
  if (k) return { known: "skipped", reason: k.reason, detail: k.detail ?? undefined, at: k.at, canonicalUrl };
  return { known: null, canonicalUrl };
}
