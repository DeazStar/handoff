import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { generatePassword, siteOf, vaultNameFor, effectiveSponsorship, collectYc, runCareerFinder, VERDICTS, type Verdict, COUNTRIES, EMPLOYMENT_TYPES, FACT_KINDS, defaultVerifyDeps, verifyContact, type VerifyDeps, TransitionError, createHumanApi, orderForCv, type CvPlan, type DB, type JobState } from "@jobhunt/core";
import { renderCvPdf } from "@jobhunt/render";
import { VaultError, type Vault } from "@jobhunt/vault";
import { MailError, type Mailer } from "./mail.js";
import type { ReplySync } from "./replySync.js";
import { systemClipboard, type Clipboard } from "./clipboard.js";

const PUBLIC = new URL("../public/", import.meta.url);
const STATIC: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
};
const COOKIE = "jh_token";
const MAX_BODY = 1_000_000;

/** A non-JSON response, such as a PDF. */
class Raw {
  constructor(public type: string, public body: Buffer, public headers: Record<string, string> = {}) {}
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

async function readJson(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Request too large");
    chunks.push(c as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Body is not valid JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    // Job titles and descriptions come from the internet: no inline script, no external anything.
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

/** Maps what core throws to an HTTP status. Crude by design: unknown errors become 500, never 4xx. */
const VAULT_STATUS: Record<string, number> = {
  locked: 423, bad_passphrase: 403, throttled: 429, exists: 409, missing: 404, weak_passphrase: 400, bad_name: 400, corrupt: 500,
};

const MAIL_STATUS: Record<string, number> = { not_configured: 409, invalid: 400, auth: 502, unreachable: 502, rejected: 422, failed: 502 };

function statusFor(e: unknown): [number, string] {
  if (e instanceof HttpError) return [e.status, e.message];
  if (e instanceof MailError) return [MAIL_STATUS[e.code] ?? 502, e.message];
  if (e instanceof VaultError) return [VAULT_STATUS[e.code] ?? 500, e.message];
  if (e instanceof TransitionError) return [409, e.message];
  if (e instanceof TypeError || e instanceof RangeError || e instanceof SyntaxError) {
    console.error(e);
    return [500, "Internal error"];
  }
  const code = (e as { code?: string })?.code;
  if (e instanceof Error && (code?.startsWith("SQLITE_CONSTRAINT") || !code)) {
    return [/not found/i.test(e.message) ? 404 : 400, e.message];
  }
  console.error(e);
  return [500, "Internal error"];
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
const optText = (v: unknown): string | undefined => {
  const t = typeof v === "string" ? v.trim() : "";
  return t || undefined;
};
const optInt = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, "Expected a number");
  return n;
};

const int = (s: string) => {
  const n = Number(s);
  if (!Number.isInteger(n)) throw new HttpError(400, "Bad id");
  return n;
};

export function createApp(db: DB, opts: { token: string; dataDir: string; vault: Vault; mailer: Mailer; verifyDeps?: VerifyDeps; collectYc?: typeof collectYc; replySync?: ReplySync; clipboard?: Clipboard; clipboardClearMs?: number }): Server {
  const vault = opts.vault;
  const mailer = opts.mailer;
  const human = createHumanApi(db);

  type Handler = (m: RegExpMatchArray, body: any, url: URL) => unknown | Promise<unknown>;
  const routes: [string, RegExp, Handler][] = [];
  const route = (method: string, path: string, h: Handler) =>
    routes.push([method, new RegExp(`^${path}$`), h]);

  route("GET", "/api/actions", () => human.listActionsDetailed());
  route("POST", "/api/actions/(\\d+)/resolve", (m, b) => {
    if (b.status !== "done" && b.status !== "dismissed") throw new HttpError(400, "status must be done or dismissed");
    human.resolveAction(int(m[1]!), b.status);
    return { ok: true };
  });
  route("POST", "/api/actions/(\\d+)/confirm-gap", (m, b) => {
    if (b.scope !== "job" && b.scope !== "general") throw new HttpError(400, "scope must be job or general");
    if (!b.fact || !FACT_KINDS.includes(b.fact.kind)) throw new HttpError(400, "fact.kind is invalid");
    const { kind, text, dateRange } = b.fact;
    return { factId: human.confirmGap(int(m[1]!), { kind, text: String(text ?? ""), dateRange }, b.scope) };
  });

  route("GET", "/api/jobs", (_m, _b, url) => human.listJobs((url.searchParams.get("state") as JobState) ?? undefined, "priority"));
  route("GET", "/api/jobs/(\\d+)", (m) => {
    const id = int(m[1]!);
    const detail = human.getJob(id);
    if (!detail) throw new HttpError(404, "Job not found");
    const companyId = detail.job.companyId;
    const research = companyId ? human.getCompanyResearch(companyId) : null;
    return {
      ...detail,
      application: human.getApplication(id),
      messages: human.listMessages({ jobId: id }),
      posting: human.getJobDescription(id),
      people: research?.people ?? [],
      researchedAt: research?.researchedAt,
      contacts: companyId ? human.listContacts(companyId) : [],
      emails: human.listEmails().filter((e) => e.jobId === id),
      documents: human.listDocuments(id),
      actions: human.listActionsDetailed().filter((a) => a.jobId === id),
      allowedTransitions: human.allowedTransitions(detail.job.state),
    };
  });
  route("POST", "/api/jobs/(\\d+)/transition", (m, b) => {
    human.transitionJob(int(m[1]!), b.to, typeof b.reason === "string" ? b.reason : undefined);
    return { ok: true };
  });

  route("GET", "/api/facts", () => human.listFacts());
  route("POST", "/api/facts", (_m, b) => ({ id: human.addFact(b) }));
  route("PUT", "/api/facts/(\\d+)", (m, b) => (human.updateFact(int(m[1]!), b), { ok: true }));
  route("DELETE", "/api/facts/(\\d+)", (m) => (human.deleteFact(int(m[1]!)), { ok: true }));
  route("POST", "/api/facts/(\\d+)/make-general", (m) => (human.makeFactGeneral(int(m[1]!)), { ok: true }));

  route("GET", "/api/profile", () => { const p = human.getProfile(); return p ? { ...p, inferredSponsorship: p.requiresSponsorship === undefined ? effectiveSponsorship(p) : undefined } : p; });
  route("PUT", "/api/profile", (_m, b) => {
    human.setProfile({
      fullName: String(b.fullName ?? ""),
      email: optText(b.email),
      phone: optText(b.phone),
      location: optText(b.location),
      links: strings(b.links),
      workAuthorization: optText(b.workAuthorization),
      requiresSponsorship: b.requiresSponsorship === true ? true : b.requiresSponsorship === false ? false : undefined,
      noticePeriod: optText(b.noticePeriod),
      languages: strings(b.languages),
    });
    return { ok: true };
  });
  route("GET", "/api/preferences", () => human.getPreferences());
  route("PUT", "/api/preferences", (_m, b) => {
    human.setPreferences({
      roles: strings(b.roles),
      seniority: strings(b.seniority),
      locations: strings(b.locations),
      remotePolicy: b.remotePolicy,
      industries: strings(b.industries),
      exclusions: strings(b.exclusions),
      salaryFloor: optInt(b.salaryFloor),
      salaryTarget: optInt(b.salaryTarget),
      salaryCeiling: optInt(b.salaryCeiling),
      currency: optText(b.currency),
      dailyApplicationLimit: Number(b.dailyApplicationLimit),
      dailyDiscoveryLimit: Number(b.dailyDiscoveryLimit),
      searchAnySite: b.searchAnySite !== false,
      cvGuidance: optText(b.cvGuidance),
      coverLetters: b.coverLetters === "off" ? "off" : b.coverLetters === "auto" ? "auto" : undefined,
      coverGuidance: optText(b.coverGuidance),
      cookieBanners: b.cookieBanners === "necessary" ? "necessary" : b.cookieBanners === "accept" ? "accept" : undefined,
      autoMarkReplied: b.autoMarkReplied === false ? false : b.autoMarkReplied === true ? true : undefined,
      followUpDays: b.followUpDays === undefined ? undefined : Number(b.followUpDays),
      maxFollowUps: b.maxFollowUps === undefined ? undefined : Number(b.maxFollowUps),
      noResponseDays: b.noResponseDays === undefined ? undefined : Number(b.noResponseDays),
      replySnippetDays: b.replySnippetDays === undefined ? undefined : Number(b.replySnippetDays),
      replyCheckMinutes: b.replyCheckMinutes === undefined ? undefined : Number(b.replyCheckMinutes),
      countryPriority: strings(b.countryPriority),
      bccSelf: b.bccSelf !== false,
      researchMinScore: b.researchMinScore === undefined || b.researchMinScore === "" ? undefined : Number(b.researchMinScore),
      researchScope: b.researchScope,
      consentDefault: b.consentDefault || undefined,
      priorityMode: b.priorityMode || undefined,
      salaryPeriod: b.salaryPeriod || undefined, // anything but month or year is refused by the core
      batchSize: b.batchSize === undefined || b.batchSize === "" ? undefined : Number(b.batchSize),
      employmentPriority: strings(b.employmentPriority),
    });
    return { ok: true };
  });
  route("GET", "/api/companies", (_m, _b, url) => {
    const q = url.searchParams;
    const careers = q.get("careers");
    return {
      stats: human.directoryStats(),
      companies: human.listDirectory({
        q: q.get("q") ?? undefined,
        remote: q.get("remote") === "1",
        careersStatus: careers === "unknown" || careers === "found" || careers === "none" ? careers : undefined,
        verdict: q.get("verdict") === "unreviewed" || q.get("verdict") === "potential" || q.get("verdict") === "discarded" ? (q.get("verdict") as Verdict) : undefined,
        limit: 200,
      }),
    };
  });
  // Downloads Y Combinator's public list of hiring companies (one request to a fixed address) and adds them.
  route("POST", "/api/companies/collect-yc", async () => {
    const { companies, rejected } = await (opts.collectYc ?? collectYc)();
    return { ...human.importDirectory(companies), rejected };
  });
  // Looks for career pages with plain code (no model): at most 40 companies per press, a few at a time.
  route("POST", "/api/companies/find-careers", (_m, b) => runCareerFinder(db, opts.verifyDeps ?? defaultVerifyDeps, { limit: Math.min(Number(b.limit) || 40, 40) }));
  route("POST", "/api/companies/(\\d+)/verdict", (m, b) => {
    if (!VERDICTS.includes(b.verdict)) throw new HttpError(400, "verdict must be unreviewed, potential or discarded");
    human.setCompanyVerdict(int(m[1]!), b.verdict, typeof b.reason === "string" ? b.reason : undefined);
    return { ok: true };
  });
  // For a pasted list of job links: which are new, and which the pipeline already has. Opens nothing.
  route("POST", "/api/links/check", (_m, b) => human.checkLinks(Array.isArray(b.urls) ? b.urls.map(String) : []));
  route("GET", "/api/sources", () => human.listSources());
  route("POST", "/api/sources", (_m, b) => {
    if (!["jobsite", "careers_page", "email_contact", "google"].includes(b.kind)) throw new HttpError(400, "Bad source kind");
    if (!String(b.name ?? "").trim()) throw new HttpError(400, "A source needs a name");
    return { id: human.addSource({ kind: b.kind, name: String(b.name), url: optText(b.url) }) };
  });
  route("POST", "/api/sources/(\\d+)/enabled", (m, b) => (human.setSourceEnabled(int(m[1]!), b.enabled === true), { ok: true }));
  route("GET", "/api/budget", () => human.discoveryBudget());


  // ---- vault: write-only. Nothing here ever returns a secret value. ----
  const passphrase = (v: unknown) => (typeof v === "string" ? v : "");
  route("GET", "/api/vault/status", () => vault.status());
  route("POST", "/api/vault/create", async (_m, b) => (await vault.create(passphrase(b.passphrase)), vault.status()));
  route("POST", "/api/vault/unlock", async (_m, b) => (await vault.unlock(passphrase(b.passphrase)), vault.status()));
  route("POST", "/api/vault/lock", () => (vault.lock(), vault.status()));
  route("POST", "/api/vault/change-passphrase", async (_m, b) => (await vault.changePassphrase(passphrase(b.old), passphrase(b.next)), vault.status()));
  route("DELETE", "/api/vault/secrets/([^/]+)", async (m) => (await vault.remove(decodeURIComponent(m[1]!)), vault.status()));
  // Sends one short message to the user's own address, to confirm the login works before any real send.
  route("POST", "/api/vault/mail/test", async () => {
    const profile = human.getProfile();
    if (!profile?.email) throw new HttpError(400, "Set your email address in Settings first");
    const r = await mailer.send({
      to: profile.email,
      fromName: profile.fullName,
      subject: "jobhunt: test message",
      text: "This is a test from your jobhunt dashboard. If you can read it, sending works.\n\nNothing was applied to any job.",
    });
    return { ok: true, sentTo: profile.email, dryRun: r.dryRun };
  });
  // The mail login: a Gmail app password. The address defaults to the profile email.
  route("PUT", "/api/vault/mail", async (_m, b) => {
    const password = passphrase(b.password).replace(/\s+/g, "");
    if (!/^[A-Za-z0-9]{8,64}$/.test(password)) throw new HttpError(400, "That does not look like an app password (letters and digits, usually 16)");
    const user = optText(b.user) ?? human.getProfile()?.email;
    if (!user || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user)) throw new HttpError(400, "Set your email address in Settings first");
    const host = optText(b.host) ?? "smtp.gmail.com";
    const port = b.port === undefined || b.port === "" ? 465 : Number(b.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, "Bad port");
    await vault.set("mail.smtp", JSON.stringify({ host, port, user, password }));
    return vault.status();
  });



  // ---- form applications: the agent fills and records, the user checks, submits on the site and marks it ----
  route("GET", "/api/applications", (_m, _b, url) => human.listApplications(url.searchParams.get("status") ?? undefined));
  route("GET", "/api/applications/(\\d+)", (m) => {
    const a = human.getApplication(int(m[1]!));
    if (!a) throw new HttpError(404, "No application for this job");
    return a;
  });
  route("POST", "/api/applications/(\\d+)/submitted", (m) => (human.markApplicationSubmitted(int(m[1]!)), { ok: true }));
  route("POST", "/api/applications/(\\d+)/discard", (m) => (human.discardApplication(int(m[1]!)), { ok: true }));
  route("GET", "/api/standard-answers", () => human.listStandardAnswers());
  route("PUT", "/api/standard-answers", (_m, b) => (human.setStandardAnswer(String(b.label ?? ""), String(b.answer ?? "")), { ok: true }));
  route("DELETE", "/api/standard-answers/(\\d+)", (m) => (human.deleteStandardAnswer(int(m[1]!)), { ok: true }));

  // ---- email applications: the user reviews, edits and sends. The agent can only draft. ----
  route("GET", "/api/emails", (_m, _b, url) => human.listEmails(url.searchParams.get("status") ?? undefined));
  route("GET", "/api/emails/(\\d+)", (m) => {
    const e = human.getEmail(int(m[1]!));
    if (!e) throw new HttpError(404, "Email not found");
    return e;
  });
  route("PUT", "/api/emails/(\\d+)", (m, b) => (human.updateEmail(int(m[1]!), { subject: String(b.subject ?? ""), bodyText: String(b.bodyText ?? "") }), { ok: true }));
  route("POST", "/api/emails/(\\d+)/discard", (m) => (human.discardEmail(int(m[1]!)), { ok: true }));
  route("POST", "/api/emails/(\\d+)/send", async (m) => {
    const id = int(m[1]!);
    const email = human.getEmail(id);
    if (!email) throw new HttpError(404, "Email not found");

    // Everything that can be checked without touching the email comes first, so a missing step costs nothing.
    const limit = human.getPreferences()?.dailyApplicationLimit ?? 5;
    const today = human.applicationsToday();
    if (today >= limit) throw new HttpError(429, `Daily limit reached (${today} of ${limit} applications today). Raise "Applications per day" in Settings to send more.`);
    const st = vault.status();
    if (!st.unlocked) throw new VaultError("locked", "Unlock the vault first (Vault page)");
    if (!st.secrets!.some((x) => x.name === "mail.smtp")) throw new MailError("not_configured", "Save your mail app password in the Vault first");

    const profile = human.getProfile();
    if (!profile) throw new HttpError(400, "Set your name and email in Settings first");
    const attachments: { filename: string; content: Buffer }[] = [];
    if (email.attachment) {
      const doc = human.getDocument(email.attachment.documentId);
      const root = resolve(opts.dataDir, "documents") + sep;
      const full = doc ? resolve(opts.dataDir, doc.path) : "";
      if (!doc || !full.startsWith(root)) throw new HttpError(409, "The CV file for this email is missing. Run the tailoring again");
      try { attachments.push({ filename: `${profile.fullName.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "CV"}-CV.pdf`, content: readFileSync(full) }); }
      catch { throw new HttpError(409, "The CV file for this email is missing. Run the tailoring again"); }
    }

    if (email.coverAttachment) {
      const cdoc = human.getDocument(email.coverAttachment.documentId);
      const croot = resolve(opts.dataDir, "documents") + sep;
      const cfull = cdoc ? resolve(opts.dataDir, cdoc.path) : "";
      if (!cdoc || !cfull.startsWith(croot)) throw new HttpError(409, "The cover letter file for this email is missing. Write it again");
      try { attachments.push({ filename: `${profile.fullName.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "Applicant"}-Cover-Letter.pdf`, content: readFileSync(cfull) }); }
      catch { throw new HttpError(409, "The cover letter file for this email is missing. Write it again"); }
    }

    human.beginSend(id); // claims it: a second click gets an error and sends nothing
    try {
      const bcc = human.getPreferences()?.bccSelf !== false && profile.email && profile.email.toLowerCase() !== email.contact.email ? [profile.email] : undefined;
      const r = await mailer.send({ to: email.contact.email, subject: email.subject, text: email.bodyText, fromName: profile.fullName, bcc, attachments, ...(email.kind === "follow_up" && email.inReplyTo ? { inReplyTo: email.inReplyTo, references: [email.inReplyTo] } : {}) });
      if (r.dryRun) {
        human.releaseSend(id); // nothing was sent, so nothing changes
        return { ok: true, dryRun: true };
      }
      human.finishSend(id, r.messageId);
      return { ok: true, dryRun: false };
    } catch (e) {
      human.failSend(id, e instanceof MailError || e instanceof VaultError ? e.message : "Sending failed");
      throw e;
    }
  });
  // ---- accounts for sites that need one ----
  // The password is made here, saved in the vault, and copied to the clipboard by this server. No route returns it.
  const clipboard = opts.clipboard ?? systemClipboard();
  const clearMs = opts.clipboardClearMs ?? 30_000;
  route("GET", "/api/accounts", () => human.listAccounts());
  route("POST", "/api/accounts/start", async (_m, b) => {
    const site = (() => { try { return siteOf(String(b.site ?? b.pageUrl ?? "")); } catch (e) { throw new HttpError(400, (e as Error).message); } })();
    const username = String(b.username ?? human.getProfile()?.email ?? "").trim();
    if (!username) throw new HttpError(400, "Say which email or username to use, or set your email in the profile");
    if (!vault.status().unlocked) throw new VaultError("locked", "Unlock the vault first (Vault page)");
    const rules = b.passwordRules && typeof b.passwordRules === "object" ? b.passwordRules : {};
    let password: string;
    try { password = generatePassword({ minLength: Number(rules.minLength) || undefined, maxLength: Number(rules.maxLength) || undefined, symbols: rules.symbols === false ? false : undefined }); }
    catch (e) { throw new HttpError(400, (e as Error).message); }
    await vault.set(vaultNameFor(site), JSON.stringify({ username, password }));
    const id = human.createAccount({ site, username, loginUrl: optText(b.pageUrl), jobId: b.jobId === undefined ? undefined : int(String(b.jobId)) });
    return { id, site, username };
  });
  route("POST", "/api/accounts/(\\d+)/copy", async (m, b) => {
    const a = human.getAccount(int(m[1]!));
    if (!a?.vaultName) throw new HttpError(404, "No saved password for that account");
    const what = b.what === "username" ? "username" : "password";
    const text = await vault.use(a.vaultName, (raw) => String(JSON.parse(raw)[what] ?? ""));
    if (!text) throw new HttpError(404, `There is no saved ${what} for that account`);
    await clipboard.write(text);
    human.touchAccount(a.id);
    if (what === "password") {
      // Take it off the clipboard again, unless something else was copied in the meantime.
      const timer = setTimeout(async () => { try { if ((await clipboard.read()) === text) await clipboard.write(""); } catch {} }, clearMs);
      timer.unref();
    }
    return { ok: true, copied: what, clearsInSeconds: what === "password" ? Math.round(clearMs / 1000) : undefined };
  });
  route("POST", "/api/accounts/(\\d+)/confirm", (m) => (human.confirmAccount(int(m[1]!)), { ok: true }));
  route("POST", "/api/accounts/(\\d+)/verified", (m) => (human.markAccountVerified(int(m[1]!)), { ok: true }));
  route("DELETE", "/api/accounts/(\\d+)", async (m) => {
    const a = human.getAccount(int(m[1]!));
    if (!a) throw new HttpError(404, "Account not found");
    // The saved password must go with the account, so the vault has to be open.
    if (a.vaultName && !vault.status().unlocked) throw new VaultError("locked", "Unlock the vault first, so the saved password is deleted with the account");
    human.deleteAccount(a.id);
    if (a.vaultName) { try { await vault.remove(a.vaultName); } catch { /* already gone */ } }
    return { ok: true };
  });

  // ---- the tracker: everything that has gone out, and applications the user made by hand ----
  route("GET", "/api/tracker", () => human.listTracker());
  route("POST", "/api/tracker", (_m, b) => human.recordManualApplication({
    title: String(b.title ?? ""),
    company: String(b.company ?? ""),
    url: optText(b.url),
    appliedOn: String(b.appliedOn ?? ""),
    how: b.how,
    status: optText(b.status) as never,
    contactEmail: optText(b.contactEmail),
    contactName: optText(b.contactName),
    notes: optText(b.notes),
  }));

  // ---- replies and follow-ups ----
  // The dashboard reads the mailbox (read-only, with the login from the vault). The agent has no tool for any of this.
  route("GET", "/api/replies", () => ({
    sync: human.getSyncState(),
    running: opts.replySync?.isRunning() ?? false,
    canCheck: !!opts.replySync,
    newCount: human.newMessageCount(),
    due: human.dueFollowUps(),
    messages: human.listMessages(),
  }));
  route("POST", "/api/replies/sync", async () => {
    if (!opts.replySync) throw new HttpError(501, "Checking replies is not set up");
    if (!vault.status().unlocked) throw new VaultError("locked", "Unlock the vault first (Vault page)");
    if (!vault.status().secrets!.some((x) => x.name === "mail.smtp")) throw new MailError("not_configured", "Save your mail app password in the Vault first");
    return opts.replySync.run();
  });
  route("POST", "/api/messages/(\\d+)", (m, b) => {
    if (b.status !== undefined) human.setMessageStatus(int(m[1]!), b.status);
    if (b.category !== undefined) human.setMessageCategory(int(m[1]!), b.category);
    return { ok: true };
  });
  route("POST", "/api/messages/(\\d+)/outcome", (m, b) => {
    if (!["replied", "interview", "rejected"].includes(b.to)) throw new HttpError(400, "to must be replied, interview or rejected");
    human.applyMessageOutcome(int(m[1]!), b.to);
    return { ok: true };
  });
  route("POST", "/api/jobs/(\\d+)/follow-up", (m) => human.draftFollowUp(int(m[1]!)));
  route("POST", "/api/contacts/(\\d+)/bounced", (m) => (human.markContactBounced(int(m[1]!)), { ok: true }));
  // An address the user types. Only the domain is checked, since there is no page to find it on.
  route("POST", "/api/jobs/(\\d+)/contacts", async (m, b) => {
    const job = human.getJob(int(m[1]!));
    if (!job) throw new HttpError(404, "Job not found");
    if (!job.job.companyId) throw new HttpError(409, "This job has no company recorded, so a contact cannot be attached");
    const v = await verifyContact({ email: String(b.email ?? "") }, opts.verifyDeps ?? defaultVerifyDeps);
    if (!v.ok) throw new HttpError(400, v.reason);
    return { id: human.addContact({ companyId: job.job.companyId, email: v.email, name: optText(b.name), role: optText(b.role) }) };
  });

  // ---- CV ----
  const entryBody = (b: any, kind?: string) => ({
    kind: (kind ?? b.kind) as "work" | "project" | "education",
    title: String(b.title ?? ""),
    organization: optText(b.organization),
    location: optText(b.location),
    startDate: optText(b.startDate),
    endDate: optText(b.endDate),
    isCurrent: b.isCurrent === true,
    note: optText(b.note),
    weight: b.weight,
    country: optText(b.country),
    employmentType: optText(b.employmentType) as any,
  });
  // The choices the dashboard offers in pick lists. Free text for these caused silent mismatches.
  route("GET", "/api/lists", () => ({
    countries: COUNTRIES,
    employmentTypes: EMPLOYMENT_TYPES.map((value) => ({ value, label: value.replace("_", "-").replace(/^./, (c) => c.toUpperCase()) })),
  }));
  route("GET", "/api/cv", () => human.getCvMaterial(null));
  route("POST", "/api/cv/entries", (_m, b) => ({ id: human.addEntry(entryBody(b)) }));
  route("PUT", "/api/cv/entries/(\\d+)", (m, b) => (human.updateEntry(int(m[1]!), entryBody(b)), { ok: true }));
  route("DELETE", "/api/cv/entries/(\\d+)", (m) => (human.deleteEntry(int(m[1]!)), { ok: true }));
  route("POST", "/api/cv/entries/(\\d+)/move", (m, b) => {
    if (b.direction !== "up" && b.direction !== "down") throw new HttpError(400, "direction must be up or down");
    human.moveEntry(int(m[1]!), b.direction);
    return { ok: true };
  });
  route("POST", "/api/cv/entries/(\\d+)/bullets", (m, b) => ({ id: human.addBullet(int(m[1]!), String(b.text ?? "")) }));
  route("PUT", "/api/cv/bullets/(\\d+)", (m, b) => {
    const id = int(m[1]!);
    const fact = human.listFacts().find((f) => f.id === id && f.entryId !== undefined);
    if (!fact) throw new HttpError(404, "Bullet not found");
    human.updateFact(id, { ...fact, text: String(b.text ?? "") });
    return { ok: true };
  });
  route("PUT", "/api/cv/skills", (_m, b) => (human.setSkillGroup(String(b.group ?? ""), strings(b.items)), { ok: true }));

  // The whole CV as it stands, for checking the layout. Skips entries that have no bullets yet.
  route("GET", "/api/cv/preview.pdf", async () => {
    const m = human.getCvMaterial(null);
    // The same order any tailored CV must follow: lead entries first, then the user's country and employment priority.
    const ordered = (kind: string) => orderForCv(db, m.entries.filter((e) => e.kind === kind && e.bullets.length));
    const plan: CvPlan = {
      experience: ordered("work").map((e) => ({ entryId: e.id, bullets: e.bullets.map((x) => x.id) })),
      projects: ordered("project").map((e) => ({ entryId: e.id, bullets: e.bullets.map((x) => x.id) })),
      education: m.entries.filter((e) => e.kind === "education").map((e) => ({ entryId: e.id })),
      skills: m.skills.map((g) => ({ group: g.group, factIds: g.skills.map((x) => x.id) })),
    };
    const { cv } = human.prepareCv(plan, null);
    const { pdf, pages } = await renderCvPdf(cv);
    return new Raw("application/pdf", pdf, { "content-disposition": 'inline; filename="cv-preview.pdf"', "x-pages": String(pages) });
  });

  // A saved document's file. Only files inside the documents folder can be served.
  route("GET", "/api/documents/(\\d+)/file", (m) => {
    const doc = human.getDocument(int(m[1]!));
    if (!doc || !doc.path.toLowerCase().endsWith(".pdf")) throw new HttpError(404, "No file for this document");
    const root = resolve(opts.dataDir, "documents") + sep;
    const full = resolve(opts.dataDir, doc.path);
    if (!full.startsWith(root)) throw new HttpError(404, "No file for this document");
    let body: Buffer;
    try { body = readFileSync(full); } catch { throw new HttpError(404, "The file is missing"); }
    return new Raw("application/pdf", body, { "content-disposition": `inline; filename="${doc.kind}-v${doc.version}.pdf"` });
  });

  route("GET", "/api/sources/stats", () => human.sourceStats());
  // Deleting a document removes its record and, if it lies inside the documents folder, its file.
  route("DELETE", "/api/documents/(\\d+)", (m) => {
    const path = human.deleteDocument(int(m[1]!));
    const root = resolve(opts.dataDir, "documents") + sep;
    const full = resolve(opts.dataDir, path);
    if (full.startsWith(root)) rmSync(full, { force: true });
    return { ok: true };
  });
  route("GET", "/api/documents/(\\d+)", (m) => {
    const d = human.getDocument(int(m[1]!));
    if (!d) throw new HttpError(404, "Document not found");
    return d;
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const server = req.socket.localPort;
    const host = req.headers.host;
    // Blocks DNS-rebinding: a hostile site pointing its own name at 127.0.0.1 would send another Host.
    if (host !== `127.0.0.1:${server}` && host !== `localhost:${server}`) throw new HttpError(403, "Bad host");

    const url = new URL(req.url ?? "/", `http://${host}`);
    const method = req.method ?? "GET";

    // First visit: ?token=... sets a cookie and redirects to the clean URL.
    const qt = url.searchParams.get("token");
    if (method === "GET" && url.pathname === "/" && qt !== null && safeEqual(qt, opts.token)) {
      res.writeHead(302, {
        location: "/",
        "set-cookie": `${COOKIE}=${opts.token}; HttpOnly; SameSite=Strict; Path=/`,
        "cache-control": "no-store",
      });
      return res.end();
    }

    const bearer = req.headers.authorization?.replace(/^Bearer /, "");
    const supplied = bearer ?? readCookie(req, COOKIE) ?? "";
    if (!safeEqual(supplied, opts.token)) {
      if (url.pathname.startsWith("/api/")) throw new HttpError(401, "Unauthorized");
      return send(res, 401, "Open the dashboard with the link printed when it started.", "text/plain; charset=utf-8");
    }

    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) throw new HttpError(403, "Bad origin");

    if (method === "GET" && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname]!;
      return send(res, 200, await readFile(new URL(file, PUBLIC), "utf8"), type);
    }

    if (!url.pathname.startsWith("/api/")) throw new HttpError(404, "Not found");
    let body: any = {};
    if (method !== "GET") {
      // Requiring JSON forces browsers to preflight any cross-site request, which we never approve.
      if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) {
        throw new HttpError(415, "Content-Type must be application/json");
      }
      body = await readJson(req);
    }
    for (const [m, re, h] of routes) {
      if (m !== method) continue;
      const match = url.pathname.match(re);
      if (match) {
        const out = await h(match, body, url);
        if (out instanceof Raw) {
          res.writeHead(200, {
            "content-type": out.type,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'",
            ...out.headers,
          });
          return res.end(out.body);
        }
        return send(res, 200, out ?? null);
      }
    }
    throw new HttpError(404, "Not found");
  }

  return createServer((req, res) => {
    handle(req, res).catch((e) => {
      const [status, message] = statusFor(e);
      send(res, status, { error: message });
    });
  });
}
