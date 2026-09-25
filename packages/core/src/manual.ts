import type { DB } from "./db.js";
import { addContact, FREE_MAIL } from "./email.js";
import { canonicalizeUrl } from "./normalize.js";
import { addCandidateJob, logEvent, transitionJob } from "./jobs.js";
import { requireHuman } from "./profile.js";
import { allowedTransitions, type Actor, type JobState } from "./states.js";

/** The outcomes a manual entry can start in. */
export const MANUAL_STATUSES = ["applied", "replied", "interview", "offer", "rejected", "no_response"] as const;
export type ManualStatus = (typeof MANUAL_STATUSES)[number];

export interface ManualApplication {
  title: string;
  company: string;
  /** The posting's link, if the user still has it. */
  url?: string;
  /** The day the user applied, YYYY-MM-DD. */
  appliedOn: string;
  /** form: through a website. email: by email. */
  how: "form" | "email";
  /** Where it stands now. Default applied. */
  status?: ManualStatus;
  /** For an email application: who it went to, so replies from them can be matched. */
  contactEmail?: string;
  contactName?: string;
  notes?: string;
}

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
// The states a job walks through before the user marks it applied. Each step is one the system may take.
const BEFORE_APPLIED: JobState[] = ["found", "verified_live", "matched", "materials_ready", "awaiting_approval"];
// From applied to each outcome, one step at a time (every step is one the user may take).
const AFTER_APPLIED: Record<ManualStatus, JobState[]> = {
  applied: [],
  replied: ["replied"],
  interview: ["replied", "interview"],
  offer: ["replied", "interview", "offer"],
  rejected: ["rejected"],
  no_response: ["no_response"],
};

const today = () => new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD in the user's local day

/**
 * Records an application the user made by hand, such as one made before using this tool. It becomes a job that is already applied
 * (or replied, interview...), with its date, so it shows in the tracker, is never found and applied for again, and can have replies matched.
 * It uses neither the discovery limit nor the daily application limit for its past date.
 */
export function recordManualApplication(db: DB, input: ManualApplication, actor: Actor): { jobId: number } {
  requireHuman(actor, "the tracker");
  const title = input.title?.trim();
  const company = input.company?.trim();
  if (!title || title.length > 300) throw new Error("The job needs a title (up to 300 characters)");
  if (!company || company.length > 200) throw new Error("The job needs a company name (up to 200 characters)");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.appliedOn) || Number.isNaN(Date.parse(`${input.appliedOn}T00:00:00Z`))) throw new Error("Say the day you applied, as a date");
  if (input.appliedOn > today()) throw new Error("The day you applied cannot be in the future");
  if (input.how !== "form" && input.how !== "email") throw new Error("Say how you applied: through a website, or by email");
  const status: ManualStatus = input.status ?? "applied";
  if (!MANUAL_STATUSES.includes(status)) throw new Error("Unknown status");
  const notes = input.notes?.trim().slice(0, 1000) || null;
  let url: string | undefined;
  if (input.url?.trim()) {
    if (!/^https?:\/\//i.test(input.url.trim()) || input.url.length > 2000) throw new Error("The link must be a web link");
    url = input.url.trim();
  }
  const contactEmail = input.contactEmail?.trim().toLowerCase();
  if (contactEmail && (!EMAIL.test(contactEmail) || contactEmail.length > 254)) throw new Error("That is not a valid email address");

  return db.transaction(() => {
    // The company: reuse one with the same name, whatever its domain.
    const known = db.prepare("SELECT id FROM companies WHERE lower(name) = lower(?) ORDER BY (domain IS NOT NULL) DESC, id LIMIT 1").get(company) as { id: number } | undefined;
    let companyId = known?.id;
    if (companyId === undefined) {
      const domain = contactEmail && !FREE_MAIL.has(contactEmail.split("@")[1]!) ? contactEmail.split("@")[1] : null;
      const clash = domain ? (db.prepare("SELECT id FROM companies WHERE domain = ?").get(domain) as { id: number } | undefined) : undefined;
      companyId = clash?.id ?? Number(db.prepare("INSERT INTO companies (name, domain, discovered_via) VALUES (?, ?, 'tracker')").run(company, clash ? null : domain).lastInsertRowid);
    }

    let jobId: number;
    const canonical = url ? canonicalizeUrl(url) : undefined;
    const existing = canonical
      ? (db.prepare("SELECT id, state FROM jobs WHERE canonical_url = ?").get(canonical) as { id: number; state: JobState } | undefined)
      : (db.prepare("SELECT id, state FROM jobs WHERE company_id = ? AND lower(title) = lower(?)").get(companyId, title) as { id: number; state: JobState } | undefined);
    if (existing) {
      if (!BEFORE_APPLIED.includes(existing.state)) throw new Error(`You already track this one (job ${existing.id}, ${existing.state.replace("_", " ")})`);
      if (db.prepare("SELECT 1 FROM emails WHERE job_id = ? AND status IN ('draft','sending','failed')").get(existing.id) || db.prepare("SELECT 1 FROM applications WHERE job_id = ? AND status = 'prepared'").get(existing.id)) {
        throw new Error(`Job ${existing.id} has a prepared form or an email draft waiting. Send or discard that first, or mark it sent the usual way`);
      }
      jobId = existing.id;
    } else {
      jobId = addCandidateJob(db, { title, url: url ?? `manual:${crypto.randomUUID()}`, canonicalUrl: canonical ?? `manual:${crypto.randomUUID()}`, companyId, applyUrl: url }, actor).id;
      db.prepare("UPDATE jobs SET manual = 1, found_at = ?, match_reason = 'Applied by hand and recorded in the tracker' WHERE id = ?").run(`${input.appliedOn} 12:00:00`, jobId);
    }
    db.prepare("UPDATE jobs SET route = ? WHERE id = ?").run(input.how, jobId);

    let contactId: number | null = null;
    if (contactEmail) contactId = addContact(db, { companyId, email: contactEmail, name: input.contactName?.trim() || undefined }, actor);

    // Walk the job to applied, then to where it stands now, one allowed step at a time.
    const current = (db.prepare("SELECT state FROM jobs WHERE id = ?").get(jobId) as { state: JobState }).state;
    for (const to of BEFORE_APPLIED.slice(BEFORE_APPLIED.indexOf(current) + 1)) transitionJob(db, jobId, to, "system", "recorded in the tracker");
    transitionJob(db, jobId, "applied", actor, "applied by hand");
    for (const to of AFTER_APPLIED[status]) transitionJob(db, jobId, to, actor, "recorded in the tracker");

    db.prepare(
      `INSERT INTO applications (job_id, route, prepared_at, approved_at, sent_at, status, notes, contact_id) VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET route = excluded.route, approved_at = excluded.approved_at, sent_at = excluded.sent_at, status = 'submitted', notes = excluded.notes, contact_id = excluded.contact_id`,
    ).run(jobId, input.how, `${input.appliedOn} 12:00:00`, `${input.appliedOn} 12:00:00`, `${input.appliedOn} 12:00:00`, notes, contactId);
    db.prepare("UPDATE action_queue SET status = 'dismissed', resolved_at = datetime('now') WHERE job_id = ? AND status = 'open' AND kind IN ('confirm_submit','approve_email','follow_up','signup_needed')").run(jobId);
    logEvent(db, actor, "manual_application_recorded", jobId, { appliedOn: input.appliedOn, how: input.how, status });
    return { jobId };
  })();
}

export interface TrackerRow {
  jobId: number;
  title: string;
  company?: string;
  url?: string;
  state: JobState;
  route: "form" | "email" | "none";
  /** Recorded by hand, not by this tool. */
  manual: boolean;
  appliedAt: string;
  daysSince: number;
  notes?: string;
  contactEmail?: string;
  /** Replies waiting for the user on this job. */
  newReplies: number;
  /** The states the user may move it to. */
  allowed: JobState[];
}

const TRACKED: JobState[] = ["applied", "replied", "interview", "offer", "rejected", "no_response"];

/** Every job that has gone out, newest first, whoever applied: this tool or the user. */
export function listTracker(db: DB, nowMs: number = Date.now()): TrackerRow[] {
  const rows = db
    .prepare(
      `SELECT j.id, j.title, j.url, j.state, j.manual, j.route AS job_route, c.name AS company, a.route, a.sent_at, a.notes, ct.email AS contact_email,
         (SELECT COUNT(*) FROM messages m WHERE m.job_id = j.id AND m.status = 'new' AND m.category != 'auto_reply') AS new_replies
       FROM jobs j JOIN applications a ON a.job_id = j.id LEFT JOIN companies c ON c.id = j.company_id LEFT JOIN contacts ct ON ct.id = a.contact_id
       WHERE j.state IN (${TRACKED.map(() => "?").join(",")}) AND a.sent_at IS NOT NULL ORDER BY a.sent_at DESC, j.id DESC`,
    )
    .all(...TRACKED) as any[];
  return rows.map((r) => ({
    jobId: r.id,
    title: r.title,
    company: r.company ?? undefined,
    url: /^https?:\/\//i.test(r.url) ? r.url : undefined,
    state: r.state,
    route: r.route ?? r.job_route,
    manual: r.manual === 1,
    appliedAt: r.sent_at,
    // Calendar days, so an application recorded for "3 days ago" says 3 whatever the time of day.
    daysSince: Math.max(0, Math.round((Date.parse(`${new Date(nowMs).toLocaleDateString("sv-SE")}T00:00:00Z`) - Date.parse(`${String(r.sent_at).slice(0, 10)}T00:00:00Z`)) / 86_400_000)),
    notes: r.notes ?? undefined,
    contactEmail: r.contact_email ?? undefined,
    newReplies: r.new_replies,
    allowed: allowedTransitions(r.state, "human"),
  }));
}
