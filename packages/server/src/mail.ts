import nodemailer, { type Transporter } from "nodemailer";
import { VaultError, type Vault } from "@jobhunt/vault";

export interface SmtpLogin {
  host: string;
  port: number;
  user: string;
  password: string;
}

export type MailErrorCode = "not_configured" | "invalid" | "auth" | "unreachable" | "rejected" | "failed";

/** Messages are fixed text. They never include what the mail server said, which can echo logins. */
export class MailError extends Error {
  constructor(public code: MailErrorCode, message: string) {
    super(message);
  }
}

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  fromName?: string;
  /** Defaults to the sending address. */
  replyTo?: string;
  bcc?: string[];
  attachments?: { filename: string; content: Buffer }[];
}

export interface MailResult {
  messageId: string;
  /** True when nothing left this machine. */
  dryRun: boolean;
  /** The message as it would have been sent, in dry-run mode only. */
  preview?: string;
}

export interface Mailer {
  send(mail: OutgoingMail): Promise<MailResult>;
}

export interface MailerOptions {
  /** Builds the transport from the login. Tests pass a recording transport. */
  transportFactory?: (login: SmtpLogin) => Transporter;
  /** Sends nothing: the message is built and returned as JSON. Default: the JOBHUNT_MAIL_DRY_RUN=1 environment variable. */
  dryRun?: boolean;
}

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
const CONTROL = /[\r\n\0]/;
const MAX_SUBJECT = 200;
const MAX_BODY = 20_000;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

function checkAddress(a: string, what: string) {
  if (!EMAIL.test(a) || CONTROL.test(a) || a.length > 254) throw new MailError("invalid", `${what} is not a valid email address`);
}

function checkMail(m: OutgoingMail) {
  checkAddress(m.to, "The recipient");
  (m.bcc ?? []).forEach((b) => checkAddress(b, "A BCC address"));
  if ((m.bcc?.length ?? 0) > 3) throw new MailError("invalid", "At most 3 BCC addresses");
  if (m.replyTo) checkAddress(m.replyTo, "The reply-to address");
  // A newline in a header value would let text smuggle in extra headers or recipients.
  if (!m.subject.trim() || m.subject.length > MAX_SUBJECT || CONTROL.test(m.subject)) throw new MailError("invalid", `The subject must be one line of up to ${MAX_SUBJECT} characters`);
  if (m.fromName && (CONTROL.test(m.fromName) || m.fromName.length > 100)) throw new MailError("invalid", "The sender name is not valid");
  if (!m.text.trim() || m.text.length > MAX_BODY) throw new MailError("invalid", `The message must have text, up to ${MAX_BODY} characters`);
  const files = m.attachments ?? [];
  if (files.length > 3 || files.reduce((n, f) => n + f.content.length, 0) > MAX_ATTACHMENT_BYTES) throw new MailError("invalid", "Attachments are limited to 3 files and 5 MB in total");
}

const safeName = (n: string) => n.replace(/[\\/\0-\x1f"]/g, "_").slice(0, 100) || "attachment.pdf";

function parseLogin(raw: string): SmtpLogin {
  try {
    const l = JSON.parse(raw);
    if (typeof l.host === "string" && Number.isInteger(l.port) && typeof l.user === "string" && typeof l.password === "string") return l;
  } catch {}
  throw new MailError("not_configured", "The saved mail login is damaged. Save your app password again in the Vault");
}

function toMailError(e: unknown): MailError {
  if (e instanceof MailError) return e;
  switch ((e as { code?: string })?.code) {
    case "EAUTH":
      return new MailError("auth", "The mail server refused the login. Check the app password, and that 2-Step Verification is on");
    case "ECONNECTION": case "ETIMEDOUT": case "ESOCKET": case "ECONNREFUSED": case "ENOTFOUND": case "EDNS": case "ECONNRESET":
      return new MailError("unreachable", "Could not reach the mail server. Check your internet connection");
    case "EENVELOPE":
      return new MailError("rejected", "The mail server rejected an address");
    default:
      return new MailError("failed", "Sending failed");
  }
}

function realTransport(login: SmtpLogin): Transporter {
  return nodemailer.createTransport({
    host: login.host,
    port: login.port,
    secure: login.port === 465,
    requireTLS: login.port !== 465,
    auth: { user: login.user, pass: login.password },
    tls: { minVersion: "TLSv1.2" },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

/**
 * Sends mail using the login stored in the vault. The password is handed to this code by the
 * vault and goes no further than the transport. Plain text only: no HTML and no tracking.
 */
export function createMailer(vault: Vault, opts: MailerOptions = {}): Mailer {
  const dryRun = opts.dryRun ?? process.env.JOBHUNT_MAIL_DRY_RUN === "1";
  const factory = opts.transportFactory ?? (dryRun ? () => nodemailer.createTransport({ jsonTransport: true }) : realTransport);

  return {
    async send(mail) {
      checkMail(mail);
      try {
        return await vault.use("mail.smtp", async (raw) => {
          const login = parseLogin(raw);
          const transport = factory(login);
          try {
            const info = await transport.sendMail({
              from: { name: mail.fromName ?? "", address: login.user },
              to: mail.to,
              replyTo: mail.replyTo ?? login.user,
              bcc: mail.bcc,
              subject: mail.subject,
              text: mail.text,
              attachments: mail.attachments?.map((a) => ({ filename: safeName(a.filename), content: a.content, contentType: "application/pdf" })),
            });
            return { messageId: String(info.messageId ?? ""), dryRun, preview: dryRun ? String((info as { message?: unknown }).message ?? "") : undefined };
          } catch (e) {
            throw toMailError(e);
          } finally {
            transport.close();
          }
        });
      } catch (e) {
        if (e instanceof VaultError && e.code === "missing") {
          throw new MailError("not_configured", "Save your mail app password in the Vault first");
        }
        throw e;
      }
    },
  };
}
