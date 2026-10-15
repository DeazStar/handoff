import type { DB } from "./db.js";
import { queueAction } from "./actionQueue.js";
import { logEvent } from "./jobs.js";
import { requireHuman } from "./profile.js";
import type { InboundMessage } from "./replies.js";
import type { Actor } from "./states.js";

const hostOf = (url: string): string | undefined => {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.hostname.toLowerCase().replace(/^www\./, "") : undefined;
  } catch {
    return undefined;
  }
};
const sameSite = (a: string, b: string) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The part of a site's name people recognise: "acme" for careers.acme.com, "ashbyhq" for jobs.ashbyhq.com, "acme" for acme.co.uk. */
export function siteLabel(site: string): string {
  const parts = site.split(".");
  const tld2 = new Set(["co", "com", "org", "net", "gov", "ac"]);
  if (parts.length >= 3 && tld2.has(parts[parts.length - 2]!) && parts[parts.length - 1]!.length === 2) return parts[parts.length - 3]!;
  return parts.length >= 2 ? parts[parts.length - 2]! : site;
}

const VERIFY_WORDS = /verif|confirm\b[^\n]{0,40}\b(e-?mail|account|address|registration|sign-?up|subscription)|activate|validate|complete (your )?(registration|sign-?up|account)|finish (setting up|creating)|welcome to|set up your account|confirm it'?s you/i;

/** Does this look like the email a site sends to check an address? */
export function looksLikeVerification(m: Pick<InboundMessage, "subject" | "snippet">): boolean {
  return VERIFY_WORDS.test(m.subject) || (VERIFY_WORDS.test(m.snippet) && /verify|confirm|activate/i.test(m.snippet));
}

/** Is the message about this site? From the site, a link on the site, or the site's name in the subject or text. */
export function relatedToSite(m: Pick<InboundMessage, "fromAddr" | "subject" | "snippet" | "links">, site: string): boolean {
  const fromDomain = m.fromAddr.split("@")[1]?.toLowerCase() ?? "";
  if (fromDomain && sameSite(fromDomain, site)) return true;
  if ((m.links ?? []).some((l) => { const h = hostOf(l); return h ? sameSite(h, site) : false; })) return true;
  const label = siteLabel(site);
  if (label.length < 4) return false;
  return new RegExp(`\\b${escape(label)}\\b`, "i").test(`${m.subject} ${m.snippet}`) || new RegExp(`(^|[.@-])${escape(label)}([.-]|$)`, "i").test(fromDomain);
}

/** The link that confirms the address: one that says so, or the only link that goes to the site. */
export function pickVerificationLink(links: string[] | undefined, site: string): { url: string; host: string; related: boolean } | undefined {
  const https = (links ?? []).filter((l) => l.length <= 1000 && hostOf(l));
  const pick = https.find((l) => /verif|confirm|activate|validate|registration|sign-?up|token|magic/i.test(l)) ?? (() => {
    const onSite = https.filter((l) => sameSite(hostOf(l)!, site));
    return onSite.length === 1 ? onSite[0] : undefined;
  })();
  if (!pick) return undefined;
  const host = hostOf(pick)!;
  return { url: pick, host, related: sameSite(host, site) };
}

export interface PendingAccount {
  id: number;
  site: string;
  jobId?: number;
  since: string;
}

/** Accounts that were started in the last 7 days and are not yet verified: the only ones whose mail we look for. */
export function pendingAccounts(db: DB): PendingAccount[] {
  return (
    db
      .prepare(
        `SELECT id, site, job_id AS jobId, created_at AS since FROM accounts
         WHERE status != 'verified' AND verified_at IS NULL AND status != 'disabled' AND julianday('now') - julianday(COALESCE(confirmed_at, created_at)) <= 7 ORDER BY id`,
      )
      .all() as { id: number; site: string; jobId: number | null; since: string }[]
  ).map((r) => ({ ...r, jobId: r.jobId ?? undefined }));
}

export interface VerificationMail {
  id: number;
  accountId: number;
  site: string;
  fromAddr: string;
  subject: string;
  receivedAt: string;
  /** The link in the mail. Untrusted: shown with its host, and never opened by the server. */
  link?: string;
  linkHost?: string;
  linkRelated: boolean;
  status: "new" | "used" | "ignored";
}

export function listVerifications(db: DB): VerificationMail[] {
  return (
    db
      .prepare("SELECT v.*, a.site FROM verification_mails v JOIN accounts a ON a.id = v.account_id ORDER BY v.received_at DESC, v.id DESC LIMIT 100")
      .all() as any[]
  ).map((r) => ({
    id: r.id,
    accountId: r.account_id,
    site: r.site,
    fromAddr: r.from_addr,
    subject: r.subject,
    receivedAt: r.received_at,
    link: r.link ?? undefined,
    linkHost: r.link_host ?? undefined,
    linkRelated: r.link_related === 1,
    status: r.status,
  }));
}

/**
 * Keeps the messages that look like a verification email for a waiting account, and puts a card for each in the user's queue.
 * Nothing is opened: the link may be single-use, and it is the user who clicks it.
 */
export function ingestVerifications(db: DB, messages: InboundMessage[], actor: Actor): { found: number } {
  const pending = pendingAccounts(db);
  if (!pending.length) return { found: 0 };
  let found = 0;
  const insert = db.prepare(
    "INSERT INTO verification_mails (account_id, message_id, from_addr, subject, received_at, link, link_host, link_related) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    for (const m of messages) {
      const id = m.messageId.trim().replace(/^<|>$/g, "").toLowerCase();
      if (!id || !looksLikeVerification(m)) continue;
      if (db.prepare("SELECT 1 FROM verification_mails WHERE message_id = ?").get(id)) continue;
      for (const a of pending) {
        // Only mail that arrived after the account was started can be its verification.
        if (Date.parse(m.receivedAt) < Date.parse(`${a.since.replace(" ", "T")}Z`) - 3_600_000) continue;
        if (!relatedToSite(m, a.site)) continue;
        const link = pickVerificationLink(m.links, a.site);
        const info = insert.run(a.id, id, m.fromAddr.toLowerCase().slice(0, 254), m.subject.replace(/\s+/g, " ").trim().slice(0, 300), m.receivedAt, link?.url ?? null, link?.host ?? null, link?.related ? 1 : 0);
        queueAction(db, "signup_needed", a.jobId ?? null, {
          site: a.site, mode: "verify", accountId: a.id, verificationId: Number(info.lastInsertRowid),
          from: m.fromAddr.toLowerCase(), subject: m.subject.slice(0, 200), link: link?.url, linkHost: link?.host, linkRelated: link?.related ?? false,
        }, actor);
        logEvent(db, actor, "verification_mail_found", a.jobId ?? null, { site: a.site });
        found++;
        break;
      }
    }
  })();
  return { found };
}

/** The user opened the link and the site says the address is verified. */
export function setVerificationUsed(db: DB, id: number, actor: Actor): void {
  requireHuman(actor, "accounts");
  db.transaction(() => {
    const v = db.prepare("SELECT account_id FROM verification_mails WHERE id = ?").get(id) as { account_id: number } | undefined;
    if (!v) throw new Error(`Verification mail ${id} not found`);
    // The link is a one-time key: it is not kept once used.
    db.prepare("UPDATE verification_mails SET status = 'used', link = NULL WHERE id = ?").run(id);
    db.prepare("UPDATE accounts SET status = 'verified', verified_at = datetime('now') WHERE id = ?").run(v.account_id);
    db.prepare("UPDATE action_queue SET status = 'done', resolved_at = datetime('now') WHERE kind = 'signup_needed' AND status = 'open' AND json_extract(payload, '$.mode') = 'verify' AND json_extract(payload, '$.accountId') = ?").run(v.account_id);
    logEvent(db, actor, "account_verified", null, { id: v.account_id });
  })();
}

/** Not the right mail. */
export function ignoreVerification(db: DB, id: number, actor: Actor): void {
  requireHuman(actor, "accounts");
  db.transaction(() => {
    if (db.prepare("UPDATE verification_mails SET status = 'ignored', link = NULL WHERE id = ?").run(id).changes === 0) throw new Error(`Verification mail ${id} not found`);
    db.prepare("UPDATE action_queue SET status = 'dismissed', resolved_at = datetime('now') WHERE kind = 'signup_needed' AND status = 'open' AND json_extract(payload, '$.verificationId') = ?").run(id);
  })();
}

/** Used and old mails lose their link, and very old ones are deleted. */
export function purgeVerifications(db: DB): void {
  db.prepare("UPDATE verification_mails SET link = NULL WHERE link IS NOT NULL AND julianday('now') - julianday(created_at) > 7").run();
  db.prepare("DELETE FROM verification_mails WHERE julianday('now') - julianday(created_at) > 30").run();
}

/** What the mailbox must be asked for while accounts are waiting: mail that names the site, and mail that says "verify". */
export function verificationTargets(db: DB): { labels: string[]; since: Date } | undefined {
  const pending = pendingAccounts(db);
  if (!pending.length) return undefined;
  const oldest = Math.min(...pending.map((p) => Date.parse(`${p.since.replace(" ", "T")}Z`)));
  return { labels: [...new Set(pending.map((p) => siteLabel(p.site)).filter((l) => l.length >= 4))], since: new Date(oldest - 86_400_000) };
}
