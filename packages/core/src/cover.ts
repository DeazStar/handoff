import type { DB } from "./db.js";
import { checkProvenance, listDocuments, type Block, type SavedDocument } from "./documents.js";
import { getContact, listContacts } from "./email.js";
import { getPreferences, getProfile } from "./profile.js";

/** What Claude writes: only the body paragraphs. The greeting, sign-off, date and contact details are the server's. */
export interface CoverPlan {
  paragraphs: { text: string; factIds: number[]; kind?: "claim" | "boilerplate" }[];
}

/** Everything the renderer draws. Nothing here is free text from the agent except the paragraphs. */
export interface ResolvedCover {
  header: { name: string; email?: string; phone?: string; location?: string; links: string[] };
  /** ISO date the letter was written. */
  date: string;
  /** Who it is addressed to: a person's name and role, or "Hiring team". */
  recipient: string;
  company?: string;
  subject: string;
  greeting: string;
  paragraphs: string[];
  closing: string;
  signature: string;
}

export const COVER_LIMITS = { minParagraphs: 2, maxParagraphs: 4, minWords: 120, maxWords: 380, maxPages: 1, maxParagraphChars: 900 } as const;

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** The first name to greet, from a contact's full name. */
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/**
 * Checks a plan and builds the letter. Every claim paragraph cites facts and its numbers must appear in them, like a CV or an email;
 * a paragraph with no facts is boilerplate and may not contain digits.
 */
export function prepareCover(
  db: DB,
  plan: CoverPlan,
  jobId: number,
  contactId?: number,
): { cover: ResolvedCover; blocks: Block[]; factIds: number[]; words: number } {
  const job = db
    .prepare("SELECT j.id, j.title, j.company_id, c.name AS company FROM jobs j LEFT JOIN companies c ON c.id = j.company_id WHERE j.id = ?")
    .get(jobId) as { id: number; title: string; company_id: number | null; company: string | null } | undefined;
  if (!job) throw new Error(`Job ${jobId} not found`);
  const profile = getProfile(db);
  if (!profile) throw new Error("The profile has no name yet (Settings, About you)");

  const n = plan.paragraphs.length;
  if (n < COVER_LIMITS.minParagraphs || n > COVER_LIMITS.maxParagraphs) {
    throw new Error(`A cover letter has ${COVER_LIMITS.minParagraphs} to ${COVER_LIMITS.maxParagraphs} paragraphs, not ${n}`);
  }
  for (const p of plan.paragraphs) {
    if (p.text.length > COVER_LIMITS.maxParagraphChars) throw new Error(`A paragraph is ${p.text.length} characters; the limit is ${COVER_LIMITS.maxParagraphChars}. Split it or cut it`);
  }
  if (!plan.paragraphs.some((p) => p.factIds.length > 0)) throw new Error("At least one paragraph must cite the facts it rests on (factIds)");

  let recipient = "Hiring team";
  let greeting = "Dear Hiring Team,";
  if (contactId !== undefined) {
    const c = getContact(db, contactId);
    if (!c) throw new Error(`Contact ${contactId} not found`);
    if (c.companyId !== job.company_id) throw new Error("That contact belongs to a different company");
    if (c.name) {
      recipient = c.role ? `${c.name}, ${c.role}` : c.name;
      greeting = `Dear ${firstName(c.name)},`;
    }
  }

  const closing = "Sincerely,";
  const blocks: Block[] = [
    { text: greeting, factIds: [], kind: "boilerplate" },
    ...plan.paragraphs.map((p): Block => ({ text: p.text.trim(), factIds: p.factIds, kind: p.factIds.length ? "claim" : "boilerplate" })),
    { text: closing, factIds: [], kind: "boilerplate" },
    { text: profile.fullName, factIds: [], kind: "boilerplate" },
  ];
  const problems = checkProvenance(db, blocks, jobId);
  if (problems.length) throw new CoverProblems(problems);

  const total = plan.paragraphs.reduce((sum, p) => sum + words(p.text), 0);
  if (total < COVER_LIMITS.minWords) throw new Error(`The letter is ${total} words; write at least ${COVER_LIMITS.minWords}`);
  if (total > COVER_LIMITS.maxWords) throw new Error(`The letter is ${total} words; the limit is ${COVER_LIMITS.maxWords}. Cut the weakest paragraph or sentences`);

  const cover: ResolvedCover = {
    header: { name: profile.fullName, email: profile.email, phone: profile.phone, location: profile.location, links: profile.links },
    date: new Date().toISOString().slice(0, 10),
    recipient,
    company: job.company ?? undefined,
    subject: `Application: ${job.title}`,
    greeting,
    paragraphs: plan.paragraphs.map((p) => p.text.trim()),
    closing,
    signature: profile.fullName,
  };
  return { cover, blocks, factIds: [...new Set(plan.paragraphs.flatMap((p) => p.factIds))].sort((a, b) => a - b), words: total };
}

export class CoverProblems extends Error {
  constructor(public problems: string[]) {
    super(`Cover letter rejected:\n- ${problems.join("\n- ")}`);
  }
}

/** "auto": a cover letter for every email job and for forms that ask. "off": none unless asked for. */
export function coverMode(db: DB): "auto" | "off" {
  return getPreferences(db)?.coverLetters === "off" ? "off" : "auto";
}

export function latestCover(db: DB, jobId: number): SavedDocument | undefined {
  return listDocuments(db, jobId).filter((d) => d.kind === "cover").sort((a, b) => b.version - a.version)[0];
}

/** The letter as plain text, for pasting into a form box. */
export function coverText(doc: SavedDocument): string {
  return doc.blocks.map((b) => b.text).join("\n\n");
}

export function getCoverMaterial(db: DB, jobId: number) {
  const job = db
    .prepare("SELECT j.id, j.title, j.route, j.company_id, c.name AS company FROM jobs j LEFT JOIN companies c ON c.id = j.company_id WHERE j.id = ?")
    .get(jobId) as { id: number; title: string; route: string; company_id: number | null; company: string | null } | undefined;
  if (!job) throw new Error(`Job ${jobId} not found`);
  const prefs = getPreferences(db);
  const contacts = job.company_id
    ? listContacts(db, job.company_id).filter((c) => c.status !== "bounced" && c.name).map((c) => ({ contactId: c.id, name: c.name, role: c.role, verification: c.verification }))
    : [];
  const existing = latestCover(db, jobId);
  return {
    job: { id: job.id, title: job.title, company: job.company ?? undefined, route: job.route },
    mode: coverMode(db),
    guidance: prefs?.coverGuidance,
    namedContacts: contacts,
    limits: { paragraphs: `${COVER_LIMITS.minParagraphs} to ${COVER_LIMITS.maxParagraphs}`, words: `${COVER_LIMITS.minWords} to ${COVER_LIMITS.maxWords}`, pages: COVER_LIMITS.maxPages },
    existing: existing ? { documentId: existing.id, version: existing.version } : undefined,
    note: "You write only the body paragraphs. The greeting, sign-off, date and the user's contact details are added by the server.",
  };
}
