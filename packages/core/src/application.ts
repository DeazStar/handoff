import type { DB } from "./db.js";
import { queueAction } from "./actionQueue.js";
import { checkProvenance, listDocuments, ProvenanceError, type Block } from "./documents.js";
import { applicationsToday, countResetAt } from "./email.js";
import { assertWellWritten } from "./writingLint.js";
import { logEvent, transitionJob } from "./jobs.js";
import { coverText } from "./cover.js";
import { norm } from "./answerCheck.js";
import { experienceSummary, listEntries } from "./cv.js";
import { checkObserved, checkProfileAnswer, checkStandardAnswer, resolveSources, type Check } from "./answerCheck.js";
import { getPreferences, getProfile, requireHuman } from "./profile.js";
import type { Actor, JobState } from "./states.js";

export const ANSWER_KINDS = ["profile", "standard", "policy", "free_text", "consent", "cover_letter"] as const;
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
  /** For a cover letter answer: the saved cover letter document that was uploaded or pasted. */
  documentId?: number;
  /** Where a profile or standard answer comes from: "profile:email", "standard:<saved label>". The server checks the source exists. */
  from?: string[];
  /** For a dropdown or radio question: the form's own options. */
  options?: string[];
  /** The value read back from the form after filling it. */
  observed?: string;
  /** Set by the server: does the answer follow from its source? Never refused for a mismatch, only flagged. */
  check?: Check;
  checkNote?: string;
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
  const since = countResetAt(db);
  const waiting = (db.prepare("SELECT COUNT(*) AS n FROM applications WHERE status = 'prepared' AND COALESCE(prepared_at, '') > ?").get(since) as { n: number }).n;
  const waitingEmails = (db.prepare("SELECT COUNT(*) AS n FROM emails WHERE kind = 'application' AND status IN ('draft','sending','failed') AND created_at > ?").get(since) as { n: number }).n;
  return applicationsToday(db) + waiting + waitingEmails;
}

/** How many more applications may be started today. Checked before a form is filled, not when it is recorded. */
export function applicationRoom(db: DB): { limit: number; used: number; remaining: number } {
  const limit = getPreferences(db)?.dailyApplicationLimit ?? 5;
  const used = capUsed(db);
  return { limit, used, remaining: Math.max(0, limit - used) };
}

/** Called before a new form is opened and filled, so the work is never done only to be refused at the end. A form already prepared (a refill) is not new. */
export function assertApplicationRoom(db: DB, jobId: number): void {
  if (getApplication(db, jobId)?.status === "prepared") return;
  const r = applicationRoom(db);
  if (r.remaining <= 0) throw new Error(`Daily limit reached (${r.used} of ${r.limit} applications used or waiting). Do not fill this form. The user can raise "Applications per day" in Settings, submit what is waiting, or reset the count`);
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
    const existing = getApplication(db, input.jobId);
    if (existing?.status === "submitted") throw new Error("This application was already submitted");
    // A form that is already prepared can be recorded again (the browser tab was lost and the form was refilled).
    const refilling = job.state === "awaiting_approval" && existing?.status === "prepared";
    if (job.state !== "materials_ready" && !refilling) throw new Error(`Build the CV first: the job must be materials_ready (it is ${job.state})`);
    if (!listDocuments(db, input.jobId).some((d) => d.kind === "cv")) throw new Error("There is no CV for this job. Run the tailoring first");
    try { new URL(input.formUrl); } catch { throw new Error("A prepared application needs the link of the form"); }
    // The daily limit is not checked here: it was checked before the form was filled (assertApplicationRoom), and a form that is already filled is always recorded.
    const prefs = getPreferences(db);

    if (input.answers.length === 0) throw new Error("Record the answers you entered");
    for (const a of input.answers) {
      if (!a.question.trim() || a.question.length > 300) throw new Error("Every answer needs the form's question (up to 300 characters)");
      if (!a.answer.trim() || a.answer.length > 5000) throw new Error(`The answer to "${a.question.slice(0, 40)}" must have text, up to 5000 characters`);
      if (!ANSWER_KINDS.includes(a.kind)) throw new Error(`Unknown answer kind "${a.kind}"`);
    }

    // A profile or standard answer must name its source, and the source must exist. If it does, the answer is saved:
    // when the wording differs from the source it is flagged for the user to read, not refused.
    const profile = getProfile(db);
    const standard = listStandardAnswers(db);
    const exp = experienceSummary(listEntries(db));
    const derived = { experienceYears: exp?.years, experienceMonths: exp?.months };
    const checkedAnswers: AnswerInput[] = input.answers.map((a) => {
      const label = `"${a.question.slice(0, 60)}"`;
      let r: { check: Check; note?: string } | undefined;
      if (a.kind === "profile" || a.kind === "standard") {
        const src = resolveSources(a.from, a.kind, { profile, standard, derived });
        if (!src.ok) throw new Error(`${label}: ${src.problem}`);
        r = a.kind === "profile" ? checkProfileAnswer(a.question, a.answer, src.fields, profile!, derived) : checkStandardAnswer(a.answer, src.labels, a.options);
      } else if (a.kind === "cover_letter") {
        const doc = a.documentId === undefined ? undefined : listDocuments(db, input.jobId).find((d) => d.id === a.documentId && d.kind === "cover");
        if (!doc) throw new Error(`${label}: name the saved cover letter of this job in documentId (save_cover_letter returns it)`);
        // Pasted text must be the saved letter; an upload only says so.
        r = /^uploaded\b/i.test(a.answer.trim()) || norm(a.answer) === norm(coverText(doc))
          ? { check: "verified", note: `Cover letter version ${doc.version}` }
          : { check: "differs", note: `The text is not the saved cover letter (version ${doc.version})` };
      } else if (a.kind === "free_text") {
        r = a.factIds?.length ? { check: "verified", note: "Every claim cites your facts" } : { check: "unchecked" };
      }
      const seen = a.kind === "profile" || a.kind === "standard" ? checkObserved(a.answer, a.observed) : undefined;
      if (seen) r = seen;
      return r ? { ...a, check: r.check, checkNote: r.note?.slice(0, 300) } : { ...a, check: undefined, checkNote: undefined };
    });

    // A message or a long free-text answer must follow the writing guide (short answers such as a salary reason are not messages).
    const messages = input.answers.filter((a) => a.kind === "free_text" && a.answer.length >= 120).map((a) => a.answer);
    if (messages.length) assertWellWritten(messages, "The message you wrote");

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
    ).run(input.jobId, input.formUrl, JSON.stringify(checkedAnswers), JSON.stringify(input.leftBlank), input.salaryQuoted ?? null, salaryPeriod, input.salaryReason?.trim() ?? null, input.notes?.slice(0, 1000) ?? null);

    queueAction(db, "confirm_submit", input.jobId, { formUrl: input.formUrl, answers: input.answers.length, leftBlank: input.leftBlank.length, differ: checkedAnswers.filter((a) => a.check === "differs").length }, actor);
    if (!refilling) transitionJob(db, input.jobId, "awaiting_approval", actor, "form prepared");
    logEvent(db, actor, refilling ? "application_refilled" : "application_prepared", input.jobId, { answers: input.answers.length, leftBlank: input.leftBlank.length, differ: checkedAnswers.filter((a) => a.check === "differs").length });
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

/**
 * What was entered in a prepared form, so the agent can put the same answers back when the browser tab was lost. It returns the answers
 * exactly as recorded: nothing has to be written again. Only for a form that is still waiting for the user.
 */
export function getPreparedApplication(db: DB, jobId: number): Pick<Application, "jobId" | "formUrl" | "answers" | "leftBlank" | "salaryQuoted" | "salaryPeriod" | "salaryReason" | "preparedAt"> {
  const a = getApplication(db, jobId);
  if (!a || a.status !== "prepared") throw new Error("There is no prepared form waiting for this job");
  return { jobId: a.jobId, formUrl: a.formUrl, answers: a.answers, leftBlank: a.leftBlank, salaryQuoted: a.salaryQuoted, salaryPeriod: a.salaryPeriod, salaryReason: a.salaryReason, preparedAt: a.preparedAt };
}
