import { assertWellWritten } from "./writingLint.js";
import type { DB } from "./db.js";
import { checkProvenance, listDocuments, type Block, type SavedDocument } from "./documents.js";
import { getContact, listContacts } from "./email.js";
import { getPreferences, getProfile } from "./profile.js";
import { experienceSummary, listEntries } from "./cv.js";
import { yearsCheck } from "./cvPlan.js";
import { numberTokens } from "./documents.js";

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

/** 3 to 4 short paragraphs and 180 to 300 words on one page: the middle of what the career guides recommend, without padding. */
export const COVER_LIMITS = { minParagraphs: 3, maxParagraphs: 4, minWords: 180, maxWords: 300, maxPages: 1, maxParagraphChars: 900, maxNumbers: 2 } as const;

export const COVER_OPENING = /^\s*I(?:['’]m| am) applying for\b[^.]{0,140}\bat\b/i;
export const ECHO_POSTING = /(?:^|[.!?]\s+)(?:(?:The|This) (?:posting|role|job|position|listing|description|ad)\b|Your (?:posting|job (?:ad|description|listing)|listing)\b|You(?:['’]re| are) (?:building|looking|hiring|seeking)\b)/;
const BONUS = /\b(?:is|are) (?:a|an) (?:bonus|plus|nice[- ]to[- ]have)\b[^.!?]{0,30}/i;

/** The names of the user's employers and projects' organizations, for checks that an employer is named once. */
export function employerNames(db: DB): string[] {
  return [...new Set(listEntries(db).map((e) => e.organization?.trim()).filter((o): o is string => Boolean(o && o.length >= 3)))];
}

/** Problems with the shape of a letter, beyond the writing rules: how it opens, echoing the posting, and an employer named twice. */
export function coverShapeProblems(db: DB, paragraphs: string[]): string[] {
  const out: string[] = [];
  if (!COVER_OPENING.test(paragraphs[0] ?? "")) out.push("paragraph 1 must start \"I'm applying for the <role> at <company>.\"");
  paragraphs.forEach((t, i) => {
    const echo = ECHO_POSTING.exec(t);
    if (echo) out.push(`paragraph ${i + 1}: "${echo[0].trim().slice(0, 40)}..." repeats the posting back. Talk about what you did; name the role once, in the first sentence`);
    const bonus = BONUS.exec(t);
    if (bonus) out.push(`paragraph ${i + 1}: "${bonus[0].trim()}" talks about the posting's wish list. Say "I've also built X" if it is true, or leave it out`);
  });
  for (const org of employerNames(db)) {
    const esc = org.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const where = paragraphs.flatMap((t, i) => (new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, "i").test(t) ? [i + 1] : []));
    if (where.length > 1) out.push(`${org} is named in paragraphs ${where.join(" and ")}. Each employer appears once, in one paragraph`);
  }
  return out;
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** The first name to greet, from a contact's full name. */
export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

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
  assertWellWritten(plan.paragraphs.map((p) => p.text), "The cover letter");
  if (!plan.paragraphs.some((p) => p.factIds.length > 0)) throw new Error("At least one paragraph must cite the facts it rests on (factIds)");

  let recipient = "Hiring Manager";
  let greeting = "Dear Hiring Manager,";
  if (contactId !== undefined) {
    const c = getContact(db, contactId);
    if (!c) throw new Error(`Contact ${contactId} not found`);
    if (c.companyId !== job.company_id) throw new Error("That contact belongs to a different company");
    if (c.name) {
      recipient = c.role ? `${c.name}, ${c.role}` : c.name;
      greeting = `Dear ${firstName(c.name)},`;
    }
  }

  if (!profile.email) throw new Error("Add your email in the profile first: the letter's sender block needs it");
  if (!profile.location) throw new Error("Add your city in the profile first: the letter's sender block needs it");
  const texts = plan.paragraphs.map((p) => p.text.trim());
  const shape = coverShapeProblems(db, texts);
  const years = experienceSummary(listEntries(db))?.years;
  const checks = texts.map((t) => yearsCheck(t, years));
  checks.forEach((c, i) => shape.push(...c.problems.map((x) => `paragraph ${i + 1}: ${x}`)));
  const numbers = texts.reduce((n, t, i) => n + numberTokens(t).filter((tok) => !checks[i]!.allow.includes(tok)).length, 0);
  if (numbers > COVER_LIMITS.maxNumbers) shape.push(`the letter has ${numbers} numbers; keep at most ${COVER_LIMITS.maxNumbers} (the years of experience do not count). A cover letter is not a list of results`);
  if (shape.length) throw new CoverProblems(shape);

  const closing = "Sincerely,";
  const blocks: Block[] = [
    { text: greeting, factIds: [], kind: "boilerplate" },
    ...plan.paragraphs.map((p, i): Block => ({ text: p.text.trim(), factIds: p.factIds, kind: p.factIds.length ? "claim" : "boilerplate", ...(checks[i]!.allow.length ? { allowNumbers: checks[i]!.allow } : {}) })),
    { text: closing, factIds: [], kind: "boilerplate" },
    { text: profile.fullName, factIds: [], kind: "boilerplate" },
  ];
  const problems = checkProvenance(db, blocks, jobId);
  if (problems.length) throw new CoverProblems(problems);

  const total = plan.paragraphs.reduce((sum, p) => sum + words(p.text), 0);
  if (total < COVER_LIMITS.minWords) throw new Error(`The letter is ${total} words; write at least ${COVER_LIMITS.minWords}`);
  if (total > COVER_LIMITS.maxWords) throw new Error(`The letter is ${total} words; the limit is ${COVER_LIMITS.maxWords}. Cut the weakest paragraph or sentences`);

  const cover: ResolvedCover = {
    header: { name: profile.fullName, email: profile.email, location: profile.location, links: [] },
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
    note: "You write only the body paragraphs (3 to 4, 180 to 300 words). The sender block (name, city, email), the date, the recipient, the greeting and the sign-off are added by the server.",
  };
}
