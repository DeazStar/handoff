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
export function siteOf(urlOrHost: string): string {
  const raw = urlOrHost.trim();
  try {
    const host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase().replace(/^www\./, "");
    if (!host.includes(".")) throw new Error();
    return host;
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
}

const toAccount = (r: any): AccountRow => ({
  id: r.id,
  site: r.site,
  username: r.email_used,
  confirmedAt: r.confirmed_at ?? undefined,
  verifiedAt: r.verified_at ?? undefined,
  lastUsedAt: r.last_used_at ?? undefined,
  loginUrl: r.login_url ?? undefined,
  createdAt: r.created_at,
  status: r.status,
  vaultName: r.vault_name ?? undefined,
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
    db.prepare("UPDATE action_queue SET status = 'done', resolved_at = datetime('now') WHERE kind = 'signup_needed' AND status = 'open' AND json_extract(payload, '$.site') = ?").run(a.site);
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
  const rows = db.prepare("SELECT confirmed_at, status FROM accounts WHERE site = ?").all(s) as { confirmed_at: string | null; status: string }[];
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
}

/** The agent's way to ask for an account: it queues a card for the user and stops. It never sees a password. */
export function requestAccount(db: DB, jobId: number | null, r: AccountRequest, actor: Actor): { actionId: number; site: string; alreadyOpen: boolean } {
  const site = siteOf(r.pageUrl);
  if (r.mode !== "signup" && r.mode !== "login") throw new Error("mode must be signup or login");
  const rules = r.passwordRules;
  if (rules) {
    for (const k of ["minLength", "maxLength"] as const) if (rules[k] !== undefined && (!Number.isInteger(rules[k]) || rules[k]! < 1 || rules[k]! > 256)) throw new Error(`${k} must be a whole number`);
  }
  const open = db.prepare("SELECT id FROM action_queue WHERE kind = 'signup_needed' AND status = 'open' AND json_extract(payload, '$.site') = ? AND IFNULL(job_id, 0) = IFNULL(?, 0)").get(site, jobId) as { id: number } | undefined;
  if (open) return { actionId: open.id, site, alreadyOpen: true };
  const actionId = queueAction(db, "signup_needed", jobId, { site, mode: r.mode, applyUrl: r.pageUrl, passwordRules: rules, fields: r.fields?.slice(0, 12).map((f) => String(f).slice(0, 60)) }, actor);
  return { actionId, site, alreadyOpen: false };
}
