import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { InboundMessage, SyncTargets } from "@jobhunt/core";
import { VaultError, type Vault } from "@jobhunt/vault";
import { MailError } from "./mail.js";

/** Reads the mailbox. The real one talks to the mail server; tests use a fake. */
export interface ImapReader {
  fetch(targets: SyncTargets): Promise<InboundMessage[]>;
}

const MAX_SOURCE_BYTES = 30_000;
const MAX_MESSAGES_PER_SEARCH = 200;

/** Turns one raw message into what the rest of the app needs: no attachments, no full body, only a short readable snippet. */
export async function parseRaw(source: Buffer, receivedAt: Date): Promise<InboundMessage | undefined> {
  const parsed = await simpleParser(source, { skipHtmlToText: false, skipImageLinks: true });
  const messageId = parsed.messageId;
  const from = parsed.from?.value?.[0];
  if (!messageId || !from?.address) return undefined;
  const header = (name: string) => {
    const v = parsed.headers.get(name);
    return typeof v === "string" ? v : Array.isArray(v) ? v.join(" ") : v && typeof v === "object" && "text" in v ? String((v as { text: string }).text) : undefined;
  };
  const text = (parsed.text ?? "")
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith(">") && !/^on .{5,80} wrote:$/i.test(l.trim()))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const failed = header("x-failed-recipients")?.split(/[,\s]+/).find((x) => x.includes("@")) ?? /(?:to|for|recipient)[:\s]+<?([^\s<>@]+@[^\s<>]+)>?/i.exec(text)?.[1];
  const refs = parsed.references ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references]) : undefined;
  return {
    messageId,
    inReplyTo: parsed.inReplyTo,
    references: refs,
    fromAddr: from.address.toLowerCase(),
    fromName: from.name || undefined,
    subject: parsed.subject ?? "",
    receivedAt: receivedAt.toISOString(),
    snippet: text.slice(0, 500),
    autoSubmitted: header("auto-submitted"),
    xAutoreply: !!(header("x-autoreply") || header("x-autorespond")),
    precedence: header("precedence"),
    failedRecipient: /^(mailer-daemon|postmaster)@/i.test(from.address) ? failed?.replace(/[>.,;]+$/, "") : undefined,
  };
}

function toMailError(e: unknown): MailError {
  if (e instanceof MailError) return e;
  const code = (e as { code?: string })?.code ?? "";
  const text = String((e as { response?: string; message?: string })?.response ?? (e as Error)?.message ?? "");
  if ((e as { authenticationFailed?: boolean })?.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|auth/i.test(code + text)) {
    return new MailError("auth", "The mail server refused the login. Check the app password, and that IMAP access is turned on in Gmail settings");
  }
  if (/IMAP.*disabled|not enabled/i.test(text)) return new MailError("failed", "IMAP is turned off for this mailbox. Turn it on in Gmail settings (Forwarding and POP/IMAP)");
  if (["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "NoConnection"].includes(code)) return new MailError("unreachable", "Could not reach the mail server. Check your internet connection");
  return new MailError("failed", "Checking the mailbox failed");
}

/**
 * Opens the inbox read-only (the server never marks, moves or deletes anything), and asks only for mail that can belong to an
 * application: replies in a thread of ours, and messages from the companies we wrote to. The login comes from the vault and goes no further.
 */
export function createImapReader(vault: Vault, opts: { clientFactory?: (login: { host: string; port: number; user: string; password: string }) => Pick<ImapFlow, "connect" | "getMailboxLock" | "search" | "fetch" | "logout" | "close"> } = {}): ImapReader {
  return {
    async fetch(targets) {
      try {
        return await vault.use("mail.smtp", async (raw) => {
          let login: { host: string; user: string; password: string };
          try { login = JSON.parse(raw); } catch { throw new MailError("not_configured", "The saved mail login is damaged. Save your app password again in the Vault"); }
          const host = String(login.host).replace(/^smtp\./i, "imap.");
          const client =
            opts.clientFactory?.({ host, port: 993, user: login.user, password: login.password }) ??
            new ImapFlow({ host, port: 993, secure: true, auth: { user: login.user, pass: login.password }, logger: false, tls: { minVersion: "TLSv1.2" }, socketTimeout: 60_000 });
          const out = new Map<string, InboundMessage>();
          try {
            await client.connect();
            const lock = await client.getMailboxLock("INBOX", { readOnly: true });
            try {
              const searches: Record<string, unknown>[] = [
                ...targets.messageIds.map((id) => ({ since: targets.since, header: { references: id } })),
                ...targets.messageIds.map((id) => ({ since: targets.since, header: { "in-reply-to": id } })),
                ...targets.senders.map((from) => ({ since: targets.since, from })),
                { since: targets.since, from: "mailer-daemon" },
              ];
              const uids = new Set<number>();
              for (const q of searches) {
                const found = (await client.search(q as never, { uid: true })) || [];
                for (const u of found.slice(-MAX_MESSAGES_PER_SEARCH)) uids.add(u);
              }
              if (uids.size) {
                for await (const m of client.fetch([...uids].join(","), { uid: true, internalDate: true, source: { maxLength: MAX_SOURCE_BYTES } } as never, { uid: true })) {
                  if (!m.source) continue;
                  const msg = await parseRaw(m.source, m.internalDate instanceof Date ? m.internalDate : new Date(m.internalDate ?? Date.now()));
                  if (msg) out.set(msg.messageId, msg);
                }
              }
            } finally {
              lock.release();
            }
            await client.logout();
          } catch (e) {
            client.close();
            throw e;
          }
          return [...out.values()];
        });
      } catch (e) {
        if (e instanceof VaultError) throw e;
        throw toMailError(e);
      }
    },
  };
}
