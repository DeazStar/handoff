import type { DB } from "./db.js";
import { queueAction } from "./actionQueue.js";
import { listDocuments, saveDocument, type Block } from "./documents.js";
import { logEvent, transitionJob } from "./jobs.js";
import { getProfile, requireHuman } from "./profile.js";
import type { Actor, JobState } from "./states.js";

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
const CONTROL = /[\r\n\0]/;
const MAX_SUBJECT = 200;
const MAX_BODY = 20_000;
const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com", "icloud.com", "proton.me", "protonmail.com", "aol.com", "gmx.com", "mail.com"]);

// ---------- contacts ----------

export interface Contact {
  id: number;
  companyId: number;
  name?: string;
  email: string;
  role?: string;
  sourceUrl: string;
  status: "ok" | "bounced";
  addedBy: "agent" | "user";
  verifiedAt?: string;
  personId?: number;
  /** on_page: the address is shown on a page. pattern: derived from a real address at the company. user: typed by the user. */
  verification: "on_page" | "pattern" | "user";
  /** For pattern contacts: the real address, its owner and the page that the derivation rests on. */
  evidence?: { pattern: string; exampleEmail: string; exampleName: string; exampleUrl: string };
}

const toContact = (r: any): Contact => ({
  id: r.id,
  companyId: r.company_id,
  name: r.name ?? undefined,
  email: r.email,
  role: r.role ?? undefined,
  sourceUrl: r.source_url,
  status: r.status,
  addedBy: r.added_by,
  verifiedAt: r.verified_at ?? undefined,
  personId: r.person_id ?? undefined,
  verification: r.verification,
  evidence: r.evidence ? JSON.parse(r.evidence) : undefined,
});

/**
 * Stores a contact. The caller has already verified the address. A contact found by the agent must say
 * which page it was found on; one the user types is recorded as entered by them.
 */
export function addContact(
  db: DB,
  c: { companyId: number; email: string; name?: string; role?: string; sourceUrl?: string; personId?: number; verification?: "on_page" | "pattern"; evidence?: Contact["evidence"] },
  actor: Actor,
): number {
  const email = c.email.trim().toLowerCase();
  if (!EMAIL.test(email)) throw new Error("That is not a valid email address");
  if (!db.prepare("SELECT 1 FROM companies WHERE id = ?").get(c.companyId)) throw new Error(`Company ${c.companyId} not found`);
  let source = "entered by the user";
  if (actor !== "human") {
    try { source = new URL(c.sourceUrl ?? "").toString(); } catch { throw new Error("A contact found by the agent needs the page it was found on"); }
  }
  if (c.personId !== undefined && !db.prepare("SELECT 1 FROM people WHERE id = ? AND company_id = ?").get(c.personId, c.companyId)) {
    throw new Error("That person does not belong to this company");
  }
  const existing = db.prepare("SELECT id FROM contacts WHERE company_id = ? AND email = ?").get(c.companyId, email) as { id: number } | undefined;
  if (existing) return existing.id;
  const verification = actor === "human" ? "user" : (c.verification ?? "on_page");
  const info = db
    .prepare("INSERT INTO contacts (company_id, name, email, role, source_url, added_by, verified_at, person_id, verification, evidence) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)")
    .run(c.companyId, c.name?.trim() || null, email, c.role?.trim() || null, source, actor === "human" ? "user" : "agent", c.personId ?? null, verification, c.evidence ? JSON.stringify(c.evidence) : null);
  const id = Number(info.lastInsertRowid);
  logEvent(db, actor, "contact_added", null, { id, companyId: c.companyId });
  return id;
}

export function listContacts(db: DB, companyId: number): Contact[] {
  return db.prepare("SELECT * FROM contacts WHERE company_id = ? ORDER BY id").all(companyId).map(toContact);
}

export function getContact(db: DB, id: number): Contact | null {
  const r = db.prepare("SELECT * FROM contacts WHERE id = ?").get(id);
  return r ? toContact(r) : null;
}

/** After a bounce arrives in the user's inbox. The agent is told never to reuse it. */
export function markContactBounced(db: DB, id: number, actor: Actor): void {
  requireHuman(actor, "contacts");
  const info = db.prepare("UPDATE contacts SET status = 'bounced' WHERE id = ?").run(id);
  if (info.changes === 0) throw new Error(`Contact ${id} not found`);
  logEvent(db, actor, "contact_bounced", null, { id });
}

/** The agent could not find a verified address. The job stays as it is and the user applies through the site. */
export function noContactFound(db: DB, jobId: number, detail: string | undefined, actor: Actor): void {
  if (!db.prepare("SELECT 1 FROM jobs WHERE id = ?").get(jobId)) throw new Error(`Job ${jobId} not found`);
  logEvent(db, actor, "no_contact_found", jobId, { detail: detail?.slice(0, 500) });
}

// ---------- drafts ----------

export interface DraftInput {
  jobId: number;
  contactId: number;
  subject?: string;
  blocks: Block[];
  attachCvDocumentId?: number;
}

function checkSubject(subject: string) {
  if (!subject.trim() || subject.length > MAX_SUBJECT || CONTROL.test(subject)) throw new Error(`The subject must be one line of up to ${MAX_SUBJECT} characters`);
}

/**
 * The agent's draft. The body is saved as a document, so every claim must cite the user's facts and every
 * number must match. Saving a draft queues it for the user and moves the job to awaiting approval. It sends nothing.
 */
export function draftEmail(db: DB, d: DraftInput, actor: Actor): { emailId: number; documentId: number } {
  return db.transaction(() => {
    const job = db.prepare("SELECT id, title, company_id, route, state FROM jobs WHERE id = ?").get(d.jobId) as
      | { id: number; title: string; company_id: number | null; route: string; state: JobState }
      | undefined;
    if (!job) throw new Error(`Job ${d.jobId} not found`);
    if (job.route !== "email") throw new Error("This job does not apply by email. Use set_route first if the posting asks for an email application");
    if (job.state !== "materials_ready") throw new Error(`Build the CV first: the job must be materials_ready (it is ${job.state})`);

    const contact = getContact(db, d.contactId);
    if (!contact) throw new Error(`Contact ${d.contactId} not found`);
    if (contact.companyId !== job.company_id) throw new Error("That contact belongs to a different company");
    if (contact.status === "bounced") throw new Error("That address bounced before. Find another contact");

    const cvs = listDocuments(db, d.jobId).filter((x) => x.kind === "cv");
    const cv = d.attachCvDocumentId ? cvs.find((x) => x.id === d.attachCvDocumentId) : cvs.sort((a, b) => b.version - a.version)[0];
    if (!cv) throw new Error("There is no CV for this job to attach. Run the tailoring first");

    const profile = getProfile(db);
    if (!profile) throw new Error("The profile has no name yet (Settings, About you)");
    const subject = (d.subject ?? `Application: ${job.title}, ${profile.fullName}`).trim();
    checkSubject(subject);

    const doc = saveDocument(db, { jobId: d.jobId, kind: "email", path: "(email draft)", blocks: d.blocks }, actor);
    let emailId: number;
    try {
      emailId = Number(
        db.prepare("INSERT INTO emails (job_id, contact_id, subject, body_document_id, attachment_document_id) VALUES (?, ?, ?, ?, ?)").run(d.jobId, d.contactId, subject, doc.id, cv.id).lastInsertRowid,
      );
    } catch (e) {
      if (String((e as Error).message).includes("UNIQUE")) throw new Error("There is already an open draft for this job and contact. Discard it first");
      throw e;
    }
    queueAction(db, "approve_email", d.jobId, { emailId, to: contact.email, subject }, actor);
    transitionJob(db, d.jobId, "awaiting_approval", actor, "email drafted");
    logEvent(db, actor, "email_drafted", d.jobId, { emailId });
    return { emailId, documentId: doc.id };
  })();
}

// ---------- reading and editing ----------

export interface EmailDetail {
  id: number;
  jobId: number;
  jobTitle: string;
  company?: string;
  contact: Contact;
  subject: string;
  /** What will be sent: the user's edit if there is one, otherwise the agent's draft with the signature. */
  bodyText: string;
  edited: boolean;
  attachment?: { documentId: number; version: number };
  status: "draft" | "sending" | "sent" | "failed" | "discarded";
  error?: string;
  messageId?: string;
  createdAt: string;
  sentAt?: string;
  /** The address is on a different domain from the company's. */
  domainMismatch: boolean;
  /** The company's domain is not recorded, or the address is a free mail address, so it cannot be compared. */
  domainUnclear: boolean;
}

function signature(db: DB): string {
  const p = getProfile(db);
  if (!p) return "";
  return ["", p.fullName, p.phone, p.email].filter((x) => x !== undefined && x !== null && x !== "").join("\n");
}

/** The email as the agent wrote it: one paragraph per block, then the user's name and contact details. */
export function composeBody(db: DB, blocks: Block[]): string {
  return blocks.map((b) => b.text).join("\n\n") + "\n" + signature(db);
}

function sameSite(a: string, b: string): boolean {
  return a === b || a.endsWith("." + b) || b.endsWith("." + a);
}

export function getEmail(db: DB, id: number): EmailDetail | null {
  const r = db
    .prepare(
      `SELECT e.*, j.title AS job_title, c.name AS company, c.domain AS company_domain, d.content AS blocks
       FROM emails e JOIN jobs j ON j.id = e.job_id LEFT JOIN companies c ON c.id = j.company_id JOIN documents d ON d.id = e.body_document_id WHERE e.id = ?`,
    )
    .get(id) as any;
  if (!r) return null;
  const contact = getContact(db, r.contact_id)!;
  const emailDomain = contact.email.split("@")[1]!;
  const companyDomain: string | undefined = r.company_domain ?? undefined;
  const att = r.attachment_document_id ? (db.prepare("SELECT id, version FROM documents WHERE id = ?").get(r.attachment_document_id) as { id: number; version: number }) : undefined;
  return {
    id: r.id,
    jobId: r.job_id,
    jobTitle: r.job_title,
    company: r.company ?? undefined,
    contact,
    subject: r.subject,
    bodyText: r.body_text ?? composeBody(db, JSON.parse(r.blocks)),
    edited: r.body_text !== null,
    attachment: att ? { documentId: att.id, version: att.version } : undefined,
    status: r.status,
    error: r.error ?? undefined,
    messageId: r.message_id ?? undefined,
    createdAt: r.created_at,
    sentAt: r.sent_at ?? undefined,
    domainMismatch: !!companyDomain && !FREE_MAIL.has(emailDomain) && !sameSite(emailDomain, companyDomain),
    domainUnclear: !companyDomain || FREE_MAIL.has(emailDomain),
  };
}

export function listEmails(db: DB, opts: { status?: string } = {}): EmailDetail[] {
  const rows = (opts.status
    ? db.prepare("SELECT id FROM emails WHERE status = ? ORDER BY id DESC").all(opts.status)
    : db.prepare("SELECT id FROM emails ORDER BY id DESC").all()) as { id: number }[];
  return rows.map((r) => getEmail(db, r.id)!);
}

/** The user's own words. A draft or a failed send can be edited; nothing else. */
export function updateEmail(db: DB, id: number, edit: { subject: string; bodyText: string }, actor: Actor): void {
  requireHuman(actor, "emails");
  const email = getEmail(db, id);
  if (!email) throw new Error(`Email ${id} not found`);
  if (email.status !== "draft" && email.status !== "failed") throw new Error(`An email that is ${email.status} cannot be edited`);
  checkSubject(edit.subject);
  if (!edit.bodyText.trim() || edit.bodyText.length > MAX_BODY) throw new Error(`The message must have text, up to ${MAX_BODY} characters`);
  db.prepare("UPDATE emails SET subject = ?, body_text = ?, updated_at = datetime('now') WHERE id = ?").run(edit.subject.trim(), edit.bodyText, id);
  logEvent(db, actor, "email_edited", email.jobId, { id });
}

export function discardEmail(db: DB, id: number, actor: Actor): void {
  requireHuman(actor, "emails");
  db.transaction(() => {
    const email = getEmail(db, id);
    if (!email) throw new Error(`Email ${id} not found`);
    if (email.status !== "draft" && email.status !== "failed") throw new Error(`An email that is ${email.status} cannot be discarded`);
    db.prepare("UPDATE emails SET status = 'discarded', updated_at = datetime('now') WHERE id = ?").run(id);
    db.prepare("UPDATE action_queue SET status = 'dismissed', resolved_at = datetime('now') WHERE kind = 'approve_email' AND status = 'open' AND json_extract(payload, '$.emailId') = ?").run(id);
    const job = db.prepare("SELECT state FROM jobs WHERE id = ?").get(email.jobId) as { state: JobState };
    if (job.state === "awaiting_approval") transitionJob(db, email.jobId, "materials_ready", actor, "email draft discarded");
    logEvent(db, actor, "email_discarded", email.jobId, { id });
  })();
}

// ---------- sending (the dashboard calls these around the actual send) ----------

/** How many applications have gone out today, by the user's local day. */
export function applicationsToday(db: DB): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM applications WHERE date(sent_at, 'localtime') = date('now', 'localtime')").get() as { n: number }).n;
}

/** Claims the email for sending. Only one caller can: a double click gets an error and sends nothing. */
export function beginSend(db: DB, id: number, actor: Actor): EmailDetail {
  requireHuman(actor, "emails");
  return db.transaction(() => {
    const info = db.prepare("UPDATE emails SET status = 'sending', error = NULL, updated_at = datetime('now') WHERE id = ? AND status IN ('draft','failed')").run(id);
    if (info.changes === 0) throw new Error("This email is not waiting to be sent (it may already be sending or sent)");
    const email = getEmail(db, id)!;
    if (email.contact.status === "bounced") {
      throw new Error("That address bounced before. Discard this draft and find another contact");
    }
    return email;
  })();
}

export function finishSend(db: DB, id: number, messageId: string, actor: Actor): void {
  requireHuman(actor, "emails");
  db.transaction(() => {
    const email = getEmail(db, id);
    if (!email || email.status !== "sending") throw new Error("This email is not being sent");
    db.prepare("UPDATE emails SET status = 'sent', message_id = ?, sent_at = datetime('now'), error = NULL, updated_at = datetime('now') WHERE id = ?").run(messageId, id);
    db.prepare(
      `INSERT INTO applications (job_id, route, prepared_at, approved_at, sent_at) VALUES (?, 'email', ?, datetime('now'), datetime('now'))
       ON CONFLICT(job_id) DO UPDATE SET route = 'email', approved_at = datetime('now'), sent_at = datetime('now')`,
    ).run(email.jobId, email.createdAt);
    db.prepare("UPDATE action_queue SET status = 'done', resolved_at = datetime('now') WHERE kind = 'approve_email' AND status = 'open' AND json_extract(payload, '$.emailId') = ?").run(id);
    const job = db.prepare("SELECT state FROM jobs WHERE id = ?").get(email.jobId) as { state: JobState };
    if (job.state === "awaiting_approval") transitionJob(db, email.jobId, "applied", actor, "email sent");
    logEvent(db, actor, "email_sent", email.jobId, { id });
  })();
}

export function failSend(db: DB, id: number, message: string, actor: Actor): void {
  requireHuman(actor, "emails");
  db.prepare("UPDATE emails SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ? AND status = 'sending'").run(message.slice(0, 300), id);
  logEvent(db, actor, "email_failed", null, { id });
}

/** Gives back a claimed email without sending it, for a dry run. */
export function releaseSend(db: DB, id: number, actor: Actor): void {
  requireHuman(actor, "emails");
  db.prepare("UPDATE emails SET status = 'draft', updated_at = datetime('now') WHERE id = ? AND status = 'sending'").run(id);
}
