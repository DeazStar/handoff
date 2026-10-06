import type { DB } from "./db.js";
import { queueAction } from "./actionQueue.js";
import { checkProvenance, listDocuments, ProvenanceError, type Block } from "./documents.js";
import { applicationsToday } from "./email.js";
import { logEvent, transitionJob } from "./jobs.js";
import { getPreferences, requireHuman } from "./profile.js";
import type { Actor, JobState } from "./states.js";

export const ANSWER_KINDS = ["profile", "standard", "policy", "free_text", "consent"] as const;
export type AnswerKind = (typeof ANSWER_KINDS)[number];

export interface AnswerInput {
  /** The form's own wording. */
  question: string;
  answer: string;
  /** profile: from the user's profile. standard: from their saved answers. policy: the salary rule. free_text: written for this job. consent: a consent box ticked because the user allowed it for this run. */
  kind: AnswerKind;
  /** Salary, work authorization and similar: the user should look at these first. */
  sensitive?: boolean;
  /** A free-text answer that makes claims about the user must cite the facts behind them. */
  factIds?: number[];
}

export interface PrepareInput {
  jobId: number;
  formUrl: string;
  answers: AnswerInput[];
  /** What the agent did not answer and why: demographics, consent, signatures, passwords, CAPTCHAs. */
  leftBlank: { question: string; why: string }[];
  salaryQuoted?: number;
  salaryReason?: string;
  notes?: string;
}

export interface Application {
  id: number;
  jobId: number;
  route: "form" | "email";
  status: "prepared" | "submitted" | "discarded";
  formUrl?: string;
  answers: AnswerInput[];
  leftBlank: { question: string; why: string }[];
  salaryQuoted?: number;
  salaryPeriod?: string;
  salaryReason?: string;
  notes?: string;
  preparedAt?: string;
  sentAt?: string;
}

const toApplication = (r: any): Application => ({
  id: r.id,
  jobId: r.job_id,
  route: r.route,
  status: r.status,
  formUrl: r.form_url ?? undefined,
  answers: Array.isArray(JSON.parse(r.answers)) ? JSON.parse(r.answers) : [],
  leftBlank: JSON.parse(r.left_blank),
  salaryQuoted: r.salary_quoted ?? undefined,
  salaryPeriod: r.salary_period ?? undefined,
  salaryReason: r.salary_reason ?? undefined,
  notes: r.notes ?? undefined,
  preparedAt: r.prepared_at ?? undefined,
  sentAt: r.sent_at ?? undefined,
});

export function getApplication(db: DB, jobId: number): Application | null {
  const r = db.prepare("SELECT * FROM applications WHERE job_id = ?").get(jobId);
  return r ? toApplication(r) : null;
}

export interface ApplicationRow extends Application {
  jobTitle: string;
  company?: string;
}

export function listApplications(db: DB, status?: string): ApplicationRow[] {
  const rows = (status
    ? db.prepare("SELECT a.*, j.title AS job_title, c.name AS company FROM applications a JOIN jobs j ON j.id = a.job_id LEFT JOIN companies c ON c.id = j.company_id WHERE a.status = ? ORDER BY a.id DESC").all(status)
    : db.prepare("SELECT a.*, j.title AS job_title, c.name AS company FROM applications a JOIN jobs j ON j.id = a.job_id LEFT JOIN companies c ON c.id = j.company_id ORDER BY a.id DESC").all()) as any[];
  return rows.map((r) => ({ ...toApplication(r), jobTitle: r.job_title, company: r.company ?? undefined }));
}

/** Prepared forms waiting for the user, plus today's submissions, against the user's daily limit. */
function capUsed(db: DB): number {
  const waiting = (db.prepare("SELECT COUNT(*) AS n FROM applications WHERE status = 'prepared'").get() as { n: number }).n;
  const waitingEmails = (db.prepare("SELECT COUNT(*) AS n FROM emails WHERE status IN ('draft','sending','failed')").get() as { n: number }).n;
  return applicationsToday(db) + waiting + waitingEmails;
}

/**
 * Records a form the agent filled in the browser and left open for the user. Nothing is submitted: the user
 * checks the form and the answers listed here, submits on the site, and then marks it submitted.
 */
export function prepareApplication(db: DB, input: PrepareInput, actor: Actor): { applicationId: number } {
  return db.transaction(() => {
    const job = db.prepare("SELECT id, route, state FROM jobs WHERE id = ?").get(input.jobId) as { id: number; route: string; state: JobState } | undefined;
    if (!job) throw new Error(`Job ${input.jobId} not found`);
    if (job.route !== "form") throw new Error("This job does not apply through a form");
    if (job.state !== "materials_ready") throw new Error(`Build the CV first: the job must be materials_ready (it is ${job.state})`);
    if (!listDocuments(db, input.jobId).some((d) => d.kind === "cv")) throw new Error("There is no CV for this job. Run the tailoring first");
    try { new URL(input.formUrl); } catch { throw new Error("A prepared application needs the link of the form"); }

    const existing = getApplication(db, input.jobId);
    if (existing?.status === "submitted") throw new Error("This application was already submitted");
    const prefs = getPreferences(db);
    const limit = prefs?.dailyApplicationLimit ?? 5;
    const used = capUsed(db) - (existing?.status === "prepared" ? 1 : 0);
    if (used >= limit) throw new Error(`Daily limit reached (${used} of ${limit} applications used or waiting). Raise "Applications per day" in Settings, or submit what is waiting first`);

    if (input.answers.length === 0) throw new Error("Record the answers you entered");
    for (const a of input.answers) {
      if (!a.question.trim() || a.question.length > 300) throw new Error("Every answer needs the form's question (up to 300 characters)");
      if (!a.answer.trim() || a.answer.length > 5000) throw new Error(`The answer to "${a.question.slice(0, 40)}" must have text, up to 5000 characters`);
      if (!ANSWER_KINDS.includes(a.kind)) throw new Error(`Unknown answer kind "${a.kind}"`);
    }

    // Free text about the user is checked like a CV or an email: every claim cites the facts it rests on.
    const blocks: Block[] = input.answers
      .filter((a) => a.kind === "free_text")
      .map((a) => ({ text: a.answer, factIds: a.factIds ?? [], kind: (a.factIds?.length ? "claim" : "boilerplate") as "claim" | "boilerplate" }));
    if (blocks.length) {
      const problems = checkProvenance(db, blocks, input.jobId);
      if (problems.length) throw new ProvenanceError(problems);
    }

    let salaryPeriod: string | null = null;
    if (input.salaryQuoted !== undefined) {
      const n = input.salaryQuoted;
      if (!Number.isInteger(n) || n <= 0) throw new Error("The salary must be a whole number");
      if (!prefs?.salaryPeriod) throw new Error("Set whether your salary range is per month or per year in Settings before a salary is quoted");
      if (prefs.salaryFloor === undefined && prefs.salaryCeiling === undefined) throw new Error("Set your salary range in Settings before a salary is quoted");
      if ((prefs.salaryFloor !== undefined && n < prefs.salaryFloor) || (prefs.salaryCeiling !== undefined && n > prefs.salaryCeiling)) {
        throw new Error(`The salary ${n} is outside your range (${prefs.salaryFloor ?? "no floor"} to ${prefs.salaryCeiling ?? "no ceiling"} per ${prefs.salaryPeriod}). Choose a number inside it, or leave the question for the user`);
      }
      if (!input.salaryReason || input.salaryReason.trim().length < 10) throw new Error("Say in a sentence why you chose that salary");
      salaryPeriod = prefs.salaryPeriod;
    }

    for (const old of db.prepare("SELECT id FROM action_queue WHERE kind = 'confirm_submit' AND status = 'open' AND job_id = ?").all(input.jobId) as { id: number }[]) {
      db.prepare("UPDATE action_queue SET status = 'dismissed', resolved_at = datetime('now') WHERE id = ?").run(old.id);
    }
    db.prepare(
      `INSERT INTO applications (job_id, route, prepared_at, form_url, answers, left_blank, salary_quoted, salary_period, salary_reason, notes, status)
       VALUES (?, 'form', datetime('now'), ?, ?, ?, ?, ?, ?, ?, 'prepared')
       ON CONFLICT(job_id) DO UPDATE SET route = 'form', prepared_at = datetime('now'), form_url = excluded.form_url, answers = excluded.answers,
         left_blank = excluded.left_blank, salary_quoted = excluded.salary_quoted, salary_period = excluded.salary_period,
         salary_reason = excluded.salary_reason, notes = excluded.notes, status = 'prepared', sent_at = NULL, approved_at = NULL`,
    ).run(input.jobId, input.formUrl, JSON.stringify(input.answers), JSON.stringify(input.leftBlank), input.salaryQuoted ?? null, salaryPeriod, input.salaryReason?.trim() ?? null, input.notes?.slice(0, 1000) ?? null);

    queueAction(db, "confirm_submit", input.jobId, { formUrl: input.formUrl, answers: input.answers.length, leftBlank: input.leftBlank.length }, actor);
    transitionJob(db, input.jobId, "awaiting_approval", actor, "form prepared");
    logEvent(db, actor, "application_prepared", input.jobId, { answers: input.answers.length, leftBlank: input.leftBlank.length });
    return { applicationId: getApplication(db, input.jobId)!.id };
  })();
}

/** The user submitted the form on the site themselves. This records it and counts it toward the day's limit. */
export function markApplicationSubmitted(db: DB, jobId: number, actor: Actor): void {
  requireHuman(actor, "applications");
  db.transaction(() => {
    const app = getApplication(db, jobId);
    if (!app || app.status !== "prepared") throw new Error("There is no prepared application waiting for this job");
    db.prepare("UPDATE applications SET status = 'submitted', approved_at = datetime('now'), sent_at = datetime('now') WHERE job_id = ?").run(jobId);
    db.prepare("UPDATE action_queue SET status = 'done', resolved_at = datetime('now') WHERE kind = 'confirm_submit' AND status = 'open' AND job_id = ?").run(jobId);
    const job = db.prepare("SELECT state FROM jobs WHERE id = ?").get(jobId) as { state: JobState };
    if (job.state === "awaiting_approval") transitionJob(db, jobId, "applied", actor, "form submitted");
    logEvent(db, actor, "application_submitted", jobId, {});
  })();
}

export function discardApplication(db: DB, jobId: number, actor: Actor): void {
  requireHuman(actor, "applications");
  db.transaction(() => {
    const app = getApplication(db, jobId);
    if (!app || app.status !== "prepared") throw new Error("There is no prepared application waiting for this job");
    db.prepare("UPDATE applications SET status = 'discarded' WHERE job_id = ?").run(jobId);
    db.prepare("UPDATE action_queue SET status = 'dismissed', resolved_at = datetime('now') WHERE kind = 'confirm_submit' AND status = 'open' AND job_id = ?").run(jobId);
    const job = db.prepare("SELECT state FROM jobs WHERE id = ?").get(jobId) as { state: JobState };
    if (job.state === "awaiting_approval") transitionJob(db, jobId, "materials_ready", actor, "application discarded");
    logEvent(db, actor, "application_discarded", jobId, {});
  })();
}

// ---------- the user's standard answers ----------

export interface StandardAnswer {
  id: number;
  label: string;
  answer: string;
}

export function listStandardAnswers(db: DB): StandardAnswer[] {
  return db.prepare("SELECT id, label, answer FROM standard_answers ORDER BY label").all() as StandardAnswer[];
}

/** For questions every form asks (how did you hear about us, are you willing to relocate). The user's words, not the agent's. */
export function setStandardAnswer(db: DB, label: string, answer: string, actor: Actor): void {
  requireHuman(actor, "standard answers");
  const l = label.trim();
  const a = answer.trim();
  if (!l || l.length > 200) throw new Error("A standard answer needs a label of up to 200 characters");
  if (!a || a.length > 2000) throw new Error("A standard answer needs text of up to 2000 characters");
  db.prepare("INSERT INTO standard_answers (label, answer) VALUES (?, ?) ON CONFLICT(label) DO UPDATE SET answer = excluded.answer, updated_at = datetime('now')").run(l, a);
  logEvent(db, actor, "standard_answer_set", null, { label: l });
}

export function deleteStandardAnswer(db: DB, id: number, actor: Actor): void {
  requireHuman(actor, "standard answers");
  const info = db.prepare("DELETE FROM standard_answers WHERE id = ?").run(id);
  if (info.changes === 0) throw new Error(`Standard answer ${id} not found`);
}
