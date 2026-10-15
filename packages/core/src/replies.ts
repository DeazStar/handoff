import type { DB } from "./db.js";
import { queueAction } from "./actionQueue.js";
import { FREE_MAIL, getEmail } from "./email.js";
import { saveDocument, type Block } from "./documents.js";
import { logEvent, transitionJob } from "./jobs.js";
import { verificationTargets } from "./verification.js";
import { getPreferences, requireHuman } from "./profile.js";
import type { Actor, JobState } from "./states.js";

/** One message from the mailbox, already read and reduced. Nothing in here is trusted: it came from the internet. */
export interface InboundMessage {
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  fromAddr: string;
  fromName?: string;
  subject: string;
  /** ISO time the message arrived. */
  receivedAt: string;
  /** The first part of the text, enough to read. */
  snippet: string;
  autoSubmitted?: string;
  xAutoreply?: boolean;
  precedence?: string;
  /** For a delivery failure: the address that did not take the mail. */
  failedRecipient?: string;
  /** The web links in the message (https only). Untrusted. */
  links?: string[];
}

export const CATEGORIES = ["reply", "auto_reply", "bounce", "rejection", "interview", "other"] as const;
export type Category = (typeof CATEGORIES)[number];
export const MESSAGE_STATUSES = ["new", "handled", "ignored"] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

const MAX_SNIPPET = 500;
const normId = (id: string | undefined) => (id ?? "").trim().replace(/^<|>$/g, "").toLowerCase();
const domainOf = (addr: string) => addr.trim().toLowerCase().split("@")[1] ?? "";
const sameSite = (a: string, b: string) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

/** Plain rules, no model. Order matters: a bounce is never an interview, an automatic reply is never a person. */
export function classifyMessage(m: Pick<InboundMessage, "fromAddr" | "subject" | "snippet" | "autoSubmitted" | "xAutoreply" | "precedence" | "failedRecipient">): Category {
  const from = m.fromAddr.toLowerCase();
  const text = `${m.subject}\n${m.snippet}`;
  if (m.failedRecipient || /^(mailer-daemon|postmaster)@/.test(from) || /delivery status notification|undeliverable|returned mail|delivery (has )?failed|mail delivery (failed|subsystem)|failure notice/i.test(m.subject)) return "bounce";
  if ((m.autoSubmitted && m.autoSubmitted.toLowerCase() !== "no") || m.xAutoreply || /^(auto_reply|bulk|junk)$/i.test(m.precedence ?? "") || /out of (the )?office|automatic reply|auto-?reply|autoreply|vacation reply/i.test(m.subject)) return "auto_reply";
  if (/unfortunately|not (be )?moving forward|decided to (move forward|proceed|go) with (other|another)|regret to inform|will not be (moving|proceeding)|not been selected|not selected|position has been filled|no longer (considering|being considered)/i.test(text)) return "rejection";
  if (/interview|schedule a (call|chat|meeting|time)|your availability|speak with you|next steps|book a (time|slot)|calendly\.com|would like to (meet|chat|talk)/i.test(text)) return "interview";
  return "reply";
}

interface SentEmail {
  /** Null for an application the user made by hand: there is no email of ours, so only the sender can match. */
  emailId: number | null;
  jobId: number;
  contactId: number;
  contactEmail: string;
  messageId: string;
  state: JobState;
}

function sentEmails(db: DB): SentEmail[] {
  return (
    db
      .prepare(
        `SELECT e.id AS emailId, e.job_id AS jobId, e.contact_id AS contactId, c.email AS contactEmail, e.message_id AS messageId, j.state AS state
         FROM emails e JOIN contacts c ON c.id = e.contact_id JOIN jobs j ON j.id = e.job_id
         WHERE e.status = 'sent' AND e.message_id IS NOT NULL ORDER BY e.sent_at DESC, e.id DESC`,
      )
      .all() as SentEmail[]
  ).map((r) => ({ ...r, messageId: normId(r.messageId), contactEmail: r.contactEmail.toLowerCase() }));
}

/** Jobs applied for through a form: no email of ours exists, so a reply can only be matched by who sent it. */
function formApplied(db: DB): FormApplied[] {
  const rows = db
    .prepare(
      `SELECT j.id AS jobId, j.title AS title, COALESCE(c.name, '') AS company, c.domain AS domain, c.website AS website, a.sent_at AS sentAt, j.state AS state
       FROM applications a JOIN jobs j ON j.id = a.job_id LEFT JOIN companies c ON c.id = j.company_id
       WHERE a.route = 'form' AND a.status = 'submitted' AND a.sent_at IS NOT NULL`,
    )
    .all() as { jobId: number; title: string; company: string; domain: string | null; website: string | null; sentAt: string; state: JobState }[];
  const host = (u: string | null) => { try { return u ? new URL(u.includes("://") ? u : `https://${u}`).hostname.toLowerCase().replace(/^www\./, "") : ""; } catch { return ""; } };
  return rows.map((r) => ({
    jobId: r.jobId, title: r.title, company: r.company, state: r.state,
    domain: (r.domain ?? host(r.website)).toLowerCase().replace(/^www\./, ""),
    appliedAt: Date.parse(`${r.sentAt.replace(" ", "T")}${r.sentAt.includes("T") ? "" : "Z"}`),
  }));
}

/** Applications the user made by email on their own: no message id to thread on, but the address they wrote to is known. */
function manualSent(db: DB): SentEmail[] {
  return (
    db
      .prepare(
        `SELECT a.job_id AS jobId, a.contact_id AS contactId, c.email AS contactEmail, j.state AS state
         FROM applications a JOIN jobs j ON j.id = a.job_id JOIN contacts c ON c.id = a.contact_id WHERE j.manual = 1 AND a.contact_id IS NOT NULL`,
      )
      .all() as { jobId: number; contactId: number; contactEmail: string; state: JobState }[]
  ).map((r) => ({ emailId: null, jobId: r.jobId, contactId: r.contactId, contactEmail: r.contactEmail.toLowerCase(), messageId: "", state: r.state }));
}

export interface FormApplied {
  jobId: number;
  title: string;
  company: string;
  /** The company's own domain, from its record or its website. */
  domain: string;
  /** When the application was submitted (ms since epoch). */
  appliedAt: number;
  state: JobState;
}

export type MatchedBy = "thread" | "sender" | "domain" | "platform";

export interface Match {
  /** Set when the message belongs to an email we sent. */
  email?: SentEmail;
  /** Set when it belongs to a job applied for through a form. */
  form?: FormApplied;
  by: MatchedBy;
}

/** Job platforms and applicant tracking systems whose mail names the company in the text, not in the address. */
export const PLATFORM_DOMAINS = [
  "greenhouse.io", "greenhouse-mail.io", "lever.co", "hire.lever.co", "ashbyhq.com", "workable.com", "workablemail.com", "smartrecruiters.com",
  "bamboohr.com", "recruitee.com", "teamtailor.com", "breezy.hr", "jobvite.com", "icims.com", "rippling.com", "workatastartup.com",
  "ycombinator.com", "myworkday.com", "personio.de", "personio.com", "pinpointhq.com", "gem.com",
];
const TITLE_STOP = new Set(["the", "and", "for", "with", "remote", "full", "time", "part"]);

const wordsOf = (t: string) => (t.toLowerCase().match(/[a-z0-9+#.]+/g) ?? []).map((w) => w.replace(/^[.]+|[.]+$/g, "")).filter((w) => w.length >= 2);
const hasPhrase = (text: string, phrase: string) => new RegExp(`(?<![a-z0-9])${phrase.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`).test(text.toLowerCase());

/** How much of a job title the text mentions, 0 to 1. A generic title such as "Software Engineer" needs all its words. */
function titleScore(text: string, title: string): number {
  const t = wordsOf(title).filter((w) => !TITLE_STOP.has(w));
  if (!t.length) return 0;
  const have = new Set(wordsOf(text));
  return t.filter((w) => have.has(w)).length / t.length;
}

/**
 * Which job applied for through a form this message belongs to. There is no email of ours to thread on, so the match is never certain:
 * "domain" is mail from the company's own address; "platform" is mail from a job platform that names both the company and the job title,
 * sent after the application. Both are shown to the user as a possible match, and neither moves a job by itself.
 */
export function matchFormMessage(m: InboundMessage, forms: FormApplied[]): Match | undefined {
  const live: JobState[] = ["applied", "replied", "no_response", "interview"];
  const candidates = forms.filter((f) => live.includes(f.state));
  if (!candidates.length) return undefined;
  const from = m.fromAddr.trim().toLowerCase();
  const fromDomain = domainOf(from);
  if (!fromDomain || FREE_MAIL.has(fromDomain)) return undefined;
  const text = `${m.subject}\n${m.snippet}`;
  const when = Date.parse(m.receivedAt);
  const best = (list: FormApplied[]) => [...list].sort((a, b) => titleScore(text, b.title) - titleScore(text, a.title) || b.appliedAt - a.appliedAt)[0]!;

  const own = candidates.filter((f) => f.domain && sameSite(fromDomain, f.domain));
  if (own.length) return { form: best(own), by: "domain" };

  if (PLATFORM_DOMAINS.some((p) => sameSite(fromDomain, p))) {
    const named = candidates.filter((f) => f.company.trim().length >= 3 && hasPhrase(text, f.company.trim()) && titleScore(text, f.title) >= 0.7 && (Number.isNaN(when) || when >= f.appliedAt));
    if (named.length) return { form: best(named), by: "platform" };
  }
  return undefined;
}

/** Which of our sent emails this message belongs to. A thread match is certain; a sender match is a suggestion. */
export function matchMessage(m: InboundMessage, sent: SentEmail[], forms: FormApplied[] = []): Match | undefined {
  const viaEmail = matchSentEmail(m, sent);
  return viaEmail ?? matchFormMessage(m, forms);
}

function matchSentEmail(m: InboundMessage, sent: SentEmail[]): Match | undefined {
  const ids = [m.inReplyTo, ...(m.references ?? [])].map(normId).filter(Boolean);
  if (ids.length) {
    const hit = sent.find((s) => ids.includes(s.messageId));
    if (hit) return { email: hit, by: "thread" };
  }
  // A delivery failure names the address that did not take the mail.
  if (m.failedRecipient) {
    const hit = sent.find((s) => s.contactEmail === m.failedRecipient!.trim().toLowerCase());
    if (hit) return { email: hit, by: "sender" };
  }
  const from = m.fromAddr.trim().toLowerCase();
  const fromDomain = domainOf(from);
  const live: JobState[] = ["applied", "replied", "no_response", "interview"];
  const exact = sent.find((s) => s.contactEmail === from && live.includes(s.state));
  if (exact) return { email: exact, by: "sender" };
  if (fromDomain && !FREE_MAIL.has(fromDomain)) {
    const hit = sent.find((s) => live.includes(s.state) && !FREE_MAIL.has(domainOf(s.contactEmail)) && sameSite(domainOf(s.contactEmail), fromDomain));
    if (hit) return { email: hit, by: "sender" };
  }
  return undefined;
}

export interface IngestResult {
  checked: number;
  matched: number;
  replies: number;
  bounces: number;
  /** Jobs moved to replied. */
  movedToReplied: number;
}

/**
 * Keeps the messages that belong to an application and drops the rest: unrelated mail is never stored.
 * Effects: a delivery failure marks the contact bounced; a certain (same-thread) human reply moves the job to replied
 * when the setting is on; any reply cancels a pending follow-up. A rejection or interview is only a suggestion for the user.
 */
export function ingestMessages(db: DB, messages: InboundMessage[], actor: Actor): IngestResult {
  const result: IngestResult = { checked: messages.length, matched: 0, replies: 0, bounces: 0, movedToReplied: 0 };
  const prefs = getPreferences(db);
  const autoMark = prefs?.autoMarkReplied !== false;
  db.transaction(() => {
    const sent = [...sentEmails(db), ...manualSent(db)];
    const forms = formApplied(db);
    const known = db.prepare("SELECT 1 FROM messages WHERE message_id = ?");
    const insert = db.prepare(
      `INSERT INTO messages (message_id, job_id, email_id, contact_id, from_addr, from_name, subject, received_at, snippet, category, matched_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const m of messages) {
      const id = normId(m.messageId);
      if (!id || known.get(id)) continue;
      const match = matchMessage(m, sent, forms);
      if (!match) continue;
      const category = classifyMessage(m);
      const jobId = match.email?.jobId ?? match.form!.jobId;
      insert.run(id, jobId, match.email?.emailId ?? null, match.email?.contactId ?? null, m.fromAddr.trim().toLowerCase().slice(0, 254), m.fromName?.slice(0, 200) ?? null, m.subject.replace(/\s+/g, " ").trim().slice(0, 300), m.receivedAt, m.snippet.replace(/\s+/g, " ").trim().slice(0, MAX_SNIPPET), category, match.by);
      result.matched++;
      if (match.form) {
        // A possible match for a form application: kept for the user to read, nothing happens to the job by itself.
        if (category !== "auto_reply" && category !== "bounce") result.replies++;
        continue;
      }
      if (category === "bounce") {
        db.prepare("UPDATE contacts SET status = 'bounced' WHERE id = ?").run(match.email!.contactId);
        queueAction(db, "follow_up", jobId, { reason: "bounce", emailId: match.email!.emailId, to: match.email!.contactEmail }, actor);
        result.bounces++;
        logEvent(db, actor, "email_bounced", jobId, { emailId: match.email!.emailId });
        continue;
      }
      if (category === "auto_reply") continue;
      result.replies++;
      dismissFollowUps(db, jobId);
      const state = (db.prepare("SELECT state FROM jobs WHERE id = ?").get(jobId) as { state: JobState }).state;
      if (autoMark && match.by === "thread" && (state === "applied" || state === "no_response")) {
        transitionJob(db, jobId, "replied", "system", "reply received");
        result.movedToReplied++;
      }
    }
    db.prepare("INSERT INTO mail_sync (id) VALUES (1) ON CONFLICT(id) DO NOTHING").run();
    logEvent(db, actor, "replies_checked", null, { ...result });
  })();
  return result;
}

function dismissFollowUps(db: DB, jobId: number): void {
  db.prepare("UPDATE action_queue SET status = 'dismissed', resolved_at = datetime('now') WHERE kind = 'follow_up' AND status = 'open' AND job_id = ? AND json_extract(payload, '$.reason') != 'bounce'").run(jobId);
}

// ---------- reading and the user's handling ----------

export interface MessageRow {
  id: number;
  messageId: string;
  jobId?: number;
  jobTitle?: string;
  company?: string;
  jobState?: JobState;
  contactId?: number;
  fromAddr: string;
  fromName?: string;
  subject: string;
  receivedAt: string;
  snippet: string;
  category: Category;
  matchedBy: MatchedBy;
  status: MessageStatus;
}

export function listMessages(db: DB, opts: { status?: MessageStatus; jobId?: number } = {}): MessageRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.status) { where.push("m.status = ?"); args.push(opts.status); }
  if (opts.jobId !== undefined) { where.push("m.job_id = ?"); args.push(opts.jobId); }
  const rows = db
    .prepare(
      `SELECT m.*, j.title AS job_title, j.state AS job_state, c.name AS company FROM messages m
       LEFT JOIN jobs j ON j.id = m.job_id LEFT JOIN companies c ON c.id = j.company_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY m.received_at DESC, m.id DESC LIMIT 300`,
    )
    .all(...args) as any[];
  return rows.map((r) => ({
    id: r.id,
    messageId: r.message_id,
    jobId: r.job_id ?? undefined,
    jobTitle: r.job_title ?? undefined,
    company: r.company ?? undefined,
    jobState: r.job_state ?? undefined,
    contactId: r.contact_id ?? undefined,
    fromAddr: r.from_addr,
    fromName: r.from_name ?? undefined,
    subject: r.subject,
    receivedAt: r.received_at,
    snippet: r.snippet,
    category: r.category,
    matchedBy: r.matched_by,
    status: r.status,
  }));
}

export function newMessageCount(db: DB): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE status = 'new' AND category NOT IN ('auto_reply')").get() as { n: number }).n;
}

export function setMessageStatus(db: DB, id: number, status: MessageStatus, actor: Actor): void {
  requireHuman(actor, "replies");
  if (!MESSAGE_STATUSES.includes(status)) throw new Error("status must be new, handled or ignored");
  if (db.prepare("UPDATE messages SET status = ? WHERE id = ?").run(status, id).changes === 0) throw new Error(`Message ${id} not found`);
}

/** The user corrects the suggested category. */
export function setMessageCategory(db: DB, id: number, category: Category, actor: Actor): void {
  requireHuman(actor, "replies");
  if (!CATEGORIES.includes(category)) throw new Error("Unknown category");
  if (db.prepare("UPDATE messages SET category = ? WHERE id = ?").run(category, id).changes === 0) throw new Error(`Message ${id} not found`);
}

/** The user decides what a reply means for the job: an interview or a rejection. Moving a job to interview is the user's alone. */
export function applyMessageOutcome(db: DB, id: number, to: "replied" | "interview" | "rejected", actor: Actor): void {
  requireHuman(actor, "replies");
  db.transaction(() => {
    const m = db.prepare("SELECT job_id FROM messages WHERE id = ?").get(id) as { job_id: number | null } | undefined;
    if (!m?.job_id) throw new Error(`Message ${id} is not linked to a job`);
    const state = (db.prepare("SELECT state FROM jobs WHERE id = ?").get(m.job_id) as { state: JobState }).state;
    if (state === "applied" || state === "no_response") transitionJob(db, m.job_id, "replied", actor, "reply confirmed");
    if (to !== "replied") transitionJob(db, m.job_id, to, actor, `from a reply: ${to}`);
    db.prepare("UPDATE messages SET status = 'handled' WHERE id = ?").run(id);
    dismissFollowUps(db, m.job_id);
  })();
}

/** Removes the text of old messages (kept metadata stays). Run on each check. */
export function purgeOldSnippets(db: DB): number {
  const days = getPreferences(db)?.replySnippetDays ?? 90;
  return db.prepare("UPDATE messages SET snippet = '' WHERE snippet != '' AND julianday('now') - julianday(received_at) > ?").run(days).changes;
}

export interface SyncState {
  lastRunAt?: string;
  lastError?: string;
  lastChecked: number;
  lastMatched: number;
}

export function getSyncState(db: DB): SyncState {
  const r = db.prepare("SELECT * FROM mail_sync WHERE id = 1").get() as any;
  return { lastRunAt: r?.last_run_at ?? undefined, lastError: r?.last_error ?? undefined, lastChecked: r?.last_checked ?? 0, lastMatched: r?.last_matched ?? 0 };
}

export function recordSync(db: DB, s: { error?: string; checked?: number; matched?: number }): void {
  db.prepare(
    `INSERT INTO mail_sync (id, last_run_at, last_error, last_checked, last_matched) VALUES (1, datetime('now'), ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_run_at = datetime('now'), last_error = excluded.last_error, last_checked = excluded.last_checked, last_matched = excluded.last_matched`,
  ).run(s.error ?? null, s.checked ?? 0, s.matched ?? 0);
}

// ---------- follow-ups ----------

export interface DueFollowUp {
  jobId: number;
  title: string;
  company?: string;
  /** email: a follow-up can be drafted. form: the application went through a form; check the site. manual: the user applied by hand; follow up yourself. */
  route: "email" | "form" | "manual";
  daysSince: number;
  followUpsSent: number;
}

const DAY = 86_400_000;
const parseTime = (s: string) => Date.parse(s.includes("T") ? s : `${s.replace(" ", "T")}Z`);

/** Applied jobs with no reply for the chosen number of days. A reply, a bounce or a pending draft means it is not due. */
export function dueFollowUps(db: DB, nowMs: number = Date.now()): DueFollowUp[] {
  const prefs = getPreferences(db);
  const after = prefs?.followUpDays ?? 7;
  const max = prefs?.maxFollowUps ?? 1;
  const jobs = db
    .prepare(
      `SELECT j.id, j.title, j.manual, c.name AS company, a.route, a.sent_at FROM jobs j JOIN applications a ON a.job_id = j.id
       LEFT JOIN companies c ON c.id = j.company_id WHERE j.state = 'applied' AND a.sent_at IS NOT NULL`,
    )
    .all() as { id: number; title: string; manual: number; company: string | null; route: "email" | "form"; sent_at: string }[];
  const out: DueFollowUp[] = [];
  for (const j of jobs) {
    if (db.prepare("SELECT 1 FROM messages WHERE job_id = ? AND category IN ('reply','rejection','interview')").get(j.id)) continue;
    if (j.route === "email" && !j.manual) {
      if (max === 0) continue;
      if (db.prepare("SELECT 1 FROM emails WHERE job_id = ? AND kind = 'follow_up' AND status IN ('draft','sending')").get(j.id)) continue;
      const last = db.prepare("SELECT sent_at, kind, contact_id FROM emails WHERE job_id = ? AND status = 'sent' ORDER BY sent_at DESC, id DESC LIMIT 1").get(j.id) as { sent_at: string; contact_id: number } | undefined;
      if (!last) continue;
      if (db.prepare("SELECT 1 FROM contacts WHERE id = ? AND status = 'bounced'").get(last.contact_id)) continue;
      const sentCount = (db.prepare("SELECT COUNT(*) AS n FROM emails WHERE job_id = ? AND kind = 'follow_up' AND status = 'sent'").get(j.id) as { n: number }).n;
      const days = Math.floor((nowMs - parseTime(last.sent_at)) / DAY);
      if (sentCount < max && days >= after) out.push({ jobId: j.id, title: j.title, company: j.company ?? undefined, route: "email", daysSince: days, followUpsSent: sentCount });
    } else {
      const days = Math.floor((nowMs - parseTime(j.sent_at)) / DAY);
      const already = db.prepare("SELECT 1 FROM action_queue WHERE kind = 'follow_up' AND job_id = ? AND json_extract(payload, '$.reason') = 'portal'").get(j.id);
      if (!already && days >= after) out.push({ jobId: j.id, title: j.title, company: j.company ?? undefined, route: j.manual ? "manual" : "form", daysSince: days, followUpsSent: 0 });
    }
  }
  return out;
}

export interface ScanResult {
  queued: number;
  markedNoResponse: number;
}

/** Queues a follow-up reminder for each job that is due, and marks long-silent jobs no_response. Safe to run as often as you like. */
export function scanFollowUps(db: DB, actor: Actor = "system", nowMs: number = Date.now()): ScanResult {
  const prefs = getPreferences(db);
  const result: ScanResult = { queued: 0, markedNoResponse: 0 };
  db.transaction(() => {
    for (const d of dueFollowUps(db, nowMs)) {
      if (db.prepare("SELECT 1 FROM action_queue WHERE kind = 'follow_up' AND status = 'open' AND job_id = ?").get(d.jobId)) continue;
      queueAction(db, "follow_up", d.jobId, { reason: d.route === "email" ? "no_reply" : "portal", days: d.daysSince, byHand: d.route === "manual" }, actor);
      result.queued++;
    }
    const quiet = prefs?.noResponseDays ?? 21;
    if (quiet > 0) {
      const jobs = db
        .prepare("SELECT j.id, a.sent_at FROM jobs j JOIN applications a ON a.job_id = j.id WHERE j.state = 'applied' AND a.sent_at IS NOT NULL")
        .all() as { id: number; sent_at: string }[];
      for (const j of jobs) {
        if ((nowMs - parseTime(j.sent_at)) / DAY < quiet) continue;
        if (db.prepare("SELECT 1 FROM messages WHERE job_id = ? AND category IN ('reply','rejection','interview')").get(j.id)) continue;
        if (db.prepare("SELECT 1 FROM emails WHERE job_id = ? AND kind = 'follow_up' AND status IN ('draft','sending')").get(j.id)) continue;
        transitionJob(db, j.id, "no_response", actor, `no reply after ${quiet} days`);
        dismissFollowUps(db, j.id);
        result.markedNoResponse++;
      }
    }
  })();
  return result;
}

const stripDigits = (s: string) => s.replace(/\d+/g, "").replace(/\s{2,}/g, " ").trim();

/**
 * Drafts a short reminder in the same thread as the application email. The server writes it from a fixed template: it makes no
 * claims about the user, attaches nothing and costs nothing. The user edits and sends it from the Emails page.
 */
export function draftFollowUp(db: DB, jobId: number, actor: Actor): { emailId: number } {
  requireHuman(actor, "follow-ups");
  return db.transaction(() => {
    const job = db
      .prepare("SELECT j.id, j.title, j.state, c.name AS company FROM jobs j LEFT JOIN companies c ON c.id = j.company_id WHERE j.id = ?")
      .get(jobId) as { id: number; title: string; state: JobState; company: string | null } | undefined;
    if (!job) throw new Error(`Job ${jobId} not found`);
    if (job.state !== "applied" && job.state !== "no_response") throw new Error(`A follow-up is for an application that has gone out and had no reply (this job is ${job.state})`);
    const first = db.prepare("SELECT id FROM emails WHERE job_id = ? AND kind = 'application' AND status = 'sent' ORDER BY sent_at, id LIMIT 1").get(jobId) as { id: number } | undefined;
    if (!first) throw new Error("This application did not go out by email, so there is nothing to follow up in a thread. Check the application portal");
    const orig = getEmail(db, first.id)!;
    if (!orig.messageId) throw new Error("The original email has no message id, so a follow-up cannot join its thread");
    if (orig.contact.status === "bounced") throw new Error("That address bounced. Find another contact");
    if (db.prepare("SELECT 1 FROM emails WHERE job_id = ? AND kind = 'follow_up' AND status IN ('draft','sending')").get(jobId)) throw new Error("There is already a follow-up draft for this job");
    const max = getPreferences(db)?.maxFollowUps ?? 1;
    const sent = (db.prepare("SELECT COUNT(*) AS n FROM emails WHERE job_id = ? AND kind = 'follow_up' AND status = 'sent'").get(jobId) as { n: number }).n;
    if (sent >= max) throw new Error(`You already sent ${sent} follow-up${sent === 1 ? "" : "s"}, the most allowed per application. Raise it in Settings if you want another`);

    const first1 = orig.contact.name?.trim().split(/\s+/)[0];
    const where = job.company ? ` at ${stripDigits(job.company)}` : "";
    const blocks: Block[] = [
      { text: first1 ? `Dear ${stripDigits(first1)},` : "Dear Hiring Team,", factIds: [], kind: "boilerplate" },
      { text: `I wanted to follow up on my application for the ${stripDigits(job.title)} position${where}. I remain very interested in the role and would be glad to answer any questions or share anything that would help.`, factIds: [], kind: "boilerplate" },
      { text: "Best regards,", factIds: [], kind: "boilerplate" },
    ];
    const doc = saveDocument(db, { jobId, kind: "email", path: "(follow-up draft)", blocks }, actor);
    const subject = /^re:/i.test(orig.subject) ? orig.subject : `Re: ${orig.subject}`;
    const emailId = Number(
      db.prepare("INSERT INTO emails (job_id, contact_id, subject, body_document_id, kind, in_reply_to) VALUES (?, ?, ?, ?, 'follow_up', ?)").run(jobId, orig.contact.id, subject, doc.id, orig.messageId).lastInsertRowid,
    );
    db.prepare("UPDATE action_queue SET status = 'dismissed', resolved_at = datetime('now') WHERE kind = 'follow_up' AND status = 'open' AND job_id = ?").run(jobId);
    queueAction(db, "approve_email", jobId, { emailId, to: orig.contact.email, subject, followUp: true }, actor);
    logEvent(db, actor, "follow_up_drafted", jobId, { emailId });
    return { emailId };
  })();
}

// ---------- what to ask the mailbox for ----------

export interface SyncTargets {
  /** Message-IDs of sent emails (without angle brackets): replies name one of these. */
  messageIds: string[];
  /** Addresses (free mail) or domains (companies) we wrote to: messages from them might be answers. */
  senders: string[];
  /** Look back this far. */
  since: Date;
  /** While an account waits to be verified: the names of its sites, to find the mail that checks the address. */
  verification?: { labels: string[]; since: Date };
  /** Company names of jobs applied for through a form: job platforms name the company in the text, not in the sender's address. */
  companyTerms?: string[];
}

/**
 * Only mail that can belong to an application is requested, so the mailbox is never read broadly: replies in a thread of ours,
 * and messages from the companies we wrote to. The window starts at the last check (a day earlier, for safety) or 30 days back.
 */
export function getSyncTargets(db: DB, nowMs: number = Date.now()): SyncTargets {
  const rows = db
    .prepare(
      `SELECT e.message_id AS messageId, c.email AS email FROM emails e JOIN contacts c ON c.id = e.contact_id JOIN jobs j ON j.id = e.job_id
       WHERE e.status = 'sent' AND e.message_id IS NOT NULL AND julianday('now') - julianday(e.sent_at) <= 180`,
    )
    .all() as { messageId: string; email: string }[];
  const last = getSyncState(db).lastRunAt;
  const since = last ? new Date(parseTime(last) - DAY) : new Date(nowMs - 30 * DAY);
  const senders = new Set<string>();
  for (const r of rows) {
    const d = domainOf(r.email);
    senders.add(FREE_MAIL.has(d) ? r.email.toLowerCase() : d);
  }
  for (const m of manualSent(db)) {
    const d = domainOf(m.contactEmail);
    senders.add(FREE_MAIL.has(d) ? m.contactEmail : d);
  }
  // Jobs applied for through a form: the company's own domain, and its name for the mail a job platform sends about it.
  const terms = new Set<string>();
  const live: JobState[] = ["applied", "replied", "no_response", "interview"];
  for (const f of formApplied(db)) {
    if (!live.includes(f.state) || nowMs - f.appliedAt > 180 * DAY) continue;
    if (f.domain && !FREE_MAIL.has(f.domain)) senders.add(f.domain);
    if (f.company.trim().length >= 3) terms.add(f.company.trim());
  }
  return { messageIds: [...new Set(rows.map((r) => normId(r.messageId)))], senders: [...senders], since, verification: verificationTargets(db), companyTerms: [...terms].slice(0, 40) };
}
