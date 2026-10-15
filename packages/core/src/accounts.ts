import { randomInt } from "node:crypto";
import type { DB } from "./db.js";
import { queueAction } from "./actionQueue.js";
import { logEvent } from "./jobs.js";
import { requireHuman } from "./profile.js";
import type { Actor } from "./states.js";

/** What a sign-up page asks of a password. Read from the page by the agent, or left out for the defaults. */
export interface PasswordRules {
  minLength?: number;
  maxLength?: number;
  /** False when the page forbids special characters. Default true. */
  symbols?: boolean;
}

export const DEFAULT_PASSWORD_LENGTH = 20;
const LOWER = "abcdefghijkmnopqrstuvwxyz"; // no l: it looks like 1 and I
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I and O
const DIGITS = "23456789"; // no 0, 1
const SYMBOLS = "!@#$%&*-_?";

/**
 * A random password from the operating system's secure generator. Always at least one of each kind it may use, and no look-alike
 * characters, so it can be read out or retyped if a site refuses pasting. Length is the default of 20 unless the page's rules say otherwise.
 */
export function generatePassword(rules: PasswordRules = {}): string {
  const min = Math.max(12, Math.floor(rules.minLength ?? 0));
  const max = Math.min(64, Math.floor(rules.maxLength ?? 64));
  if (min > max) throw new Error(`The page wants a password of ${min} to ${max} characters, which cannot be satisfied`);
  const length = Math.min(Math.max(DEFAULT_PASSWORD_LENGTH, min), max);
  const sets = [LOWER, UPPER, DIGITS, ...(rules.symbols === false ? [] : [SYMBOLS])];
  const all = sets.join("");
  const pick = (s: string) => s[randomInt(s.length)]!;
  const chars = sets.map(pick);
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

/** A site's name for accounts and the vault: its host, lowercase, without www. */
/**
 * Sites that share one login. A job on workatastartup.com or on ycombinator.com is applied to with the same Y Combinator account,
 * and the login itself lives at account.ycombinator.com, so all of them are one site here. Each family is one line.
 */
export const SITE_FAMILIES: { site: string; members: string[] }[] = [
  { site: "ycombinator.com", members: ["ycombinator.com", "workatastartup.com"] },
];

/** The site an account belongs to: the host without "www.", or its family's main site. */
export function canonicalSite(host: string): string {
  const h = host.toLowerCase().replace(/^www\./, "");
  const fam = SITE_FAMILIES.find((f) => f.members.some((m) => h === m || h.endsWith(`.${m}`)));
  return fam ? fam.site : h;
}

export function siteOf(urlOrHost: string): string {
  const raw = urlOrHost.trim();
  try {
    const host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase().replace(/^www\./, "");
    if (!host.includes(".")) throw new Error();
    return canonicalSite(host);
  } catch {
    throw new Error("That is not a web address");
  }
}

export const vaultNameFor = (site: string) => `site:${site}`;

export interface AccountRow {
  id: number;
  site: string;
  username: string;
  /** The user pressed "I created the account". */
  confirmedAt?: string;
  verifiedAt?: string;
  lastUsedAt?: string;
  loginUrl?: string;
  createdAt: string;
  status: "created" | "verified" | "disabled";
  /** The site a password is saved for in the vault (the password itself is never in the database). */
  vaultName?: string;
  /** The job that led to the account, if any. */
  jobId?: number;
}

const toAccount = (r: any): AccountRow => ({
  id: r.id,
  site: canonicalSite(r.site),
  username: r.email_used,
  confirmedAt: r.confirmed_at ?? undefined,
  verifiedAt: r.verified_at ?? undefined,
  lastUsedAt: r.last_used_at ?? undefined,
  loginUrl: r.login_url ?? undefined,
  createdAt: r.created_at,
  status: r.status,
  vaultName: r.vault_name ?? undefined,
  jobId: r.job_id ?? undefined,
});

export function listAccounts(db: DB): AccountRow[] {
  return (db.prepare("SELECT * FROM accounts ORDER BY created_at DESC, id DESC").all() as any[]).map(toAccount);
}

export function getAccount(db: DB, id: number): AccountRow | null {
  const r = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
  return r ? toAccount(r) : null;
}

/** Records that a password is being saved for this site. The user's dashboard writes the password to the vault; this only notes the account. */
export function createAccount(db: DB, a: { site: string; username: string; loginUrl?: string; jobId?: number }, actor: Actor): number {
  requireHuman(actor, "accounts");
  const site = siteOf(a.site);
  const username = a.username.trim();
  if (!username || username.length > 254) throw new Error("An account needs the email or username it uses");
  const vault = vaultNameFor(site);
  const existing = db.prepare("SELECT id FROM accounts WHERE site = ? AND email_used = ?").get(site, username) as { id: number } | undefined;
  if (existing) {
    db.prepare("UPDATE accounts SET vault_name = ?, login_url = COALESCE(?, login_url), confirmed_at = NULL, verified_at = NULL WHERE id = ?").run(vault, a.loginUrl ?? null, existing.id);
    logEvent(db, actor, "account_reset", a.jobId ?? null, { site });
    return existing.id;
  }
  const info = db.prepare("INSERT INTO accounts (site, email_used, vault_name, login_url, job_id) VALUES (?, ?, ?, ?, ?)").run(site, username, vault, a.loginUrl ?? null, a.jobId ?? null);
  logEvent(db, actor, "account_started", a.jobId ?? null, { site });
  return Number(info.lastInsertRowid);
}

/** The user has created the account on the site. Closes the sign-up reminders for it. */
export function confirmAccount(db: DB, id: number, actor: Actor): void {
  requireHuman(actor, "accounts");
  db.transaction(() => {
    const a = getAccount(db, id);
    if (!a) throw new Error(`Account ${id} not found`);
    db.prepare("UPDATE accounts SET confirmed_at = datetime('now'), last_used_at = datetime('now') WHERE id = ?").run(id);
    // Only the sign-up and login cards close: a verification card or a profile card for the same site is still waiting for the user.
    const cards = db.prepare("SELECT id, payload FROM action_queue WHERE kind = 'signup_needed' AND status = 'open'").all() as { id: number; payload: string }[];
    for (const c of cards) {
      const p = JSON.parse(c.payload) as { site?: string; mode?: string };
      if (p.site && canonicalSite(p.site) === a.site && ["signup", "login", undefined].includes(p.mode)) {
        db.prepare("UPDATE action_queue SET status = 'done', resolved_at = datetime('now') WHERE id = ?").run(c.id);
      }
    }
    logEvent(db, actor, "account_confirmed", null, { site: a.site });
  })();
}

export function markAccountVerified(db: DB, id: number, actor: Actor): void {
  requireHuman(actor, "accounts");
  if (db.prepare("UPDATE accounts SET status = 'verified', verified_at = datetime('now') WHERE id = ?").run(id).changes === 0) throw new Error(`Account ${id} not found`);
  logEvent(db, actor, "account_verified", null, { id });
}

export function touchAccount(db: DB, id: number): void {
  db.prepare("UPDATE accounts SET last_used_at = datetime('now') WHERE id = ?").run(id);
}

/** Removes the account record and returns the vault name, so the caller removes the saved password too. */
export function deleteAccount(db: DB, id: number, actor: Actor): string | undefined {
  requireHuman(actor, "accounts");
  const a = getAccount(db, id);
  if (!a) throw new Error(`Account ${id} not found`);
  db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
  logEvent(db, actor, "account_deleted", null, { site: a.site });
  return a.vaultName;
}

/** What the agent may know: whether an account exists for a site. Never a password, never the username. */
export function accountStatus(db: DB, site: string): { site: string; exists: boolean; confirmed: boolean; verified: boolean } {
  const s = siteOf(site);
  const rows = (db.prepare("SELECT site, confirmed_at, status FROM accounts").all() as { site: string; confirmed_at: string | null; status: string }[]).filter((r) => canonicalSite(r.site) === s);
  return { site: s, exists: rows.length > 0, confirmed: rows.some((r) => r.confirmed_at), verified: rows.some((r) => r.status === "verified") };
}

export interface AccountRequest {
  /** signup: there is no account yet. login: there is one, and the session is gone. */
  mode: "signup" | "login";
  /** The page where the account is made or the login is done. */
  pageUrl: string;
  /** What the page asks of a password, if it says. */
  passwordRules?: PasswordRules;
  /** The fields the page shows, in the agent's words: "email", "password", "confirm password"... for the user's information. */
  fields?: string[];
  /** The username the agent typed into the page, when the site logs in with a username and not the email. Not a secret. */
  username?: string;
}

/** The agent's way to ask for an account: it queues a card for the user and stops. It never sees a password. */
export function requestAccount(db: DB, jobId: number | null, r: AccountRequest, actor: Actor): { actionId: number; site: string; alreadyOpen: boolean } {
  const site = siteOf(r.pageUrl);
  if (r.mode !== "signup" && r.mode !== "login") throw new Error("mode must be signup or login");
  const rules = r.passwordRules;
  if (rules) {
    for (const k of ["minLength", "maxLength"] as const) if (rules[k] !== undefined && (!Number.isInteger(rules[k]) || rules[k]! < 1 || rules[k]! > 256)) throw new Error(`${k} must be a whole number`);
  }
  const username = r.username?.trim().slice(0, 100) || undefined;
  if (username && /\s/.test(username)) throw new Error("A username has no spaces");
  const open = db.prepare("SELECT id FROM action_queue WHERE kind = 'signup_needed' AND status = 'open' AND json_extract(payload, '$.site') = ? AND IFNULL(job_id, 0) = IFNULL(?, 0) AND IFNULL(json_extract(payload, '$.mode'), 'signup') = ?").get(site, jobId, r.mode) as { id: number } | undefined;
  if (open) return { actionId: open.id, site, alreadyOpen: true };
  const actionId = queueAction(db, "signup_needed", jobId, { site, mode: r.mode, applyUrl: r.pageUrl, passwordRules: rules, fields: r.fields?.slice(0, 12).map((f) => String(f).slice(0, 60)), username }, actor);
  return { actionId, site, alreadyOpen: false };
}

/**
 * The agent's way to say "this site has a profile that should be filled in": it queues a card with a button for the user.
 * The card opens nothing and fills nothing by itself: the user presses it and runs the /profile command.
 */
export function requestProfileFill(db: DB, jobId: number | null, r: { pageUrl: string; note?: string }, actor: Actor): { actionId: number; site: string; alreadyOpen: boolean } {
  const site = siteOf(r.pageUrl);
  const known = db.prepare("SELECT complete, updated_at FROM site_profiles WHERE site = ?").get(site) as { complete: number; updated_at: string } | undefined;
  if (known?.complete === 1) {
    throw new Error(`The profile on ${site} is already marked complete (${known.updated_at.slice(0, 10)}). Do not ask for it again. If clicking Apply really sends you to the profile setup, call mark_site_profile with complete false first, then ask`);
  }
  const open = db.prepare("SELECT id FROM action_queue WHERE kind = 'signup_needed' AND status = 'open' AND json_extract(payload, '$.site') = ? AND IFNULL(job_id, 0) = IFNULL(?, 0) AND json_extract(payload, '$.mode') = 'profile'").get(site, jobId) as { id: number } | undefined;
  if (open) return { actionId: open.id, site, alreadyOpen: true };
  const actionId = queueAction(db, "signup_needed", jobId, { site, mode: "profile", applyUrl: r.pageUrl, note: r.note?.trim().slice(0, 300) || undefined }, actor);
  return { actionId, site, alreadyOpen: false };
}

/**
 * The agent's way to ask the user a question only they can answer (equity preference, how firm a minimum salary is, a skill level).
 * It queues a card with the options, the answer is saved as a standard answer, and the agent never has to ask again.
 */
export function askUser(db: DB, jobId: number | null, q: { question: string; options?: string[]; site?: string }, actor: Actor): { actionId: number; alreadyOpen: boolean } {
  const question = q.question?.trim();
  if (!question || question.length > 200) throw new Error("A question needs text of up to 200 characters");
  const options = q.options?.map((o) => o.trim()).filter(Boolean);
  if (options && (options.length < 2 || options.length > 10 || options.some((o) => o.length > 120))) throw new Error("Give 2 to 10 options of up to 120 characters, or none for a free answer");
  if (options && new Set(options.map((o) => o.toLowerCase())).size !== options.length) throw new Error("The options must differ");
  const known = db.prepare("SELECT answer FROM standard_answers WHERE lower(label) = lower(?)").get(question) as { answer: string } | undefined;
  if (known) throw new Error(`The user already answered this: "${known.answer}". Use it (get_application_material lists the saved answers)`);
  const open = db.prepare("SELECT id FROM action_queue WHERE kind = 'sensitive_question' AND status = 'open' AND lower(json_extract(payload, '$.question')) = lower(?)").get(question) as { id: number } | undefined;
  if (open) return { actionId: open.id, alreadyOpen: true };
  const site = q.site ? (() => { try { return siteOf(q.site!); } catch { return undefined; } })() : undefined;
  const actionId = queueAction(db, "sensitive_question", jobId, { question, options, site }, actor);
  return { actionId, alreadyOpen: false };
}
