import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addFact, createAgentApi, openDb, saveDocument, setProfile, type DB, type InboundMessage } from "@jobhunt/core";
import { createVault } from "@jobhunt/vault";
import { createApp } from "../src/app.js";
import { createImapReader, parseRaw, type ImapReader } from "../src/imap.js";
import { createMailer } from "../src/mail.js";
import { createReplySync } from "../src/replySync.js";

const TOKEN = "test-token";
const PASS = "correct horse battery";
const H = "human" as const;
const eml = (headers: Record<string, string>, body: string) => Buffer.from(Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n" + body);

describe("reading a raw message", () => {
  it("takes the thread ids, the sender and a short snippet without quoted text", async () => {
    const m = (await parseRaw(eml({
      "Message-ID": "<r1@acme.example>", From: "Jane Doe <jane@acme.example>", To: "ada@gmail.com", Subject: "Re: Application: Backend Engineer",
      "In-Reply-To": "<sent1@gmail.com>", References: "<sent1@gmail.com>", Date: "Wed, 7 Oct 2026 10:00:00 +0000", "Content-Type": "text/plain; charset=utf-8",
    }, "Hi Ada,\r\n\r\nThanks for applying. Could we talk on Friday?\r\n\r\nOn Tue, 6 Oct 2026 at 09:00, Ada <ada@gmail.com> wrote:\r\n> I am applying for the role\r\n> Best regards\r\n"), new Date("2026-10-07T10:00:00Z")))!;
    expect(m).toMatchObject({ messageId: "<r1@acme.example>", inReplyTo: "<sent1@gmail.com>", fromAddr: "jane@acme.example", fromName: "Jane Doe", subject: "Re: Application: Backend Engineer", receivedAt: "2026-10-07T10:00:00.000Z" });
    expect(m.references).toEqual(["<sent1@gmail.com>"]);
    expect(m.snippet).toContain("Could we talk on Friday?");
    expect(m.snippet).not.toContain("I am applying for the role");
    expect(m.snippet).not.toContain("wrote:");
  });

  it("marks automatic mail and reads the address a bounce names", async () => {
    const auto = (await parseRaw(eml({ "Message-ID": "<a@x.example>", From: "hr@acme.example", Subject: "Automatic reply: Application", "Auto-Submitted": "auto-replied", Precedence: "bulk", "Content-Type": "text/plain" }, "I am away."), new Date()))!;
    expect(auto).toMatchObject({ autoSubmitted: "auto-replied", precedence: "bulk" });
    const bounce = (await parseRaw(eml({ "Message-ID": "<b@googlemail.com>", From: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", Subject: "Delivery Status Notification (Failure)", "X-Failed-Recipients": "jane@acme.example", "Content-Type": "text/plain" }, "Your message wasn't delivered."), new Date()))!;
    expect(bounce.failedRecipient).toBe("jane@acme.example");
    const noHeader = (await parseRaw(eml({ "Message-ID": "<c@googlemail.com>", From: "mailer-daemon@googlemail.com", Subject: "Undeliverable", "Content-Type": "text/plain" }, "Delivery to: jane@acme.example failed"), new Date()))!;
    expect(noHeader.failedRecipient).toBe("jane@acme.example");
  });

  it("skips a message with no id or no sender", async () => {
    expect(await parseRaw(eml({ From: "a@b.example", Subject: "x" }, "hi"), new Date())).toBeUndefined();
    expect(await parseRaw(eml({ "Message-ID": "<x@y>", Subject: "x" }, "hi"), new Date())).toBeUndefined();
  });
});

describe("links in a mail", () => {
  it("takes the https links from the HTML and the text, once each, and drops the rest", async () => {
    const m = (await parseRaw(Buffer.from([
      "Message-ID: <l1@x.example>", "From: noreply@careers.acme.com", "Subject: Verify your email", "MIME-Version: 1.0", 'Content-Type: multipart/alternative; boundary="b"', "", "--b",
      "Content-Type: text/plain; charset=utf-8", "", "Verify here: https://careers.acme.com/verify?token=abc&x=1. Or http://insecure.example/x", "--b", "Content-Type: text/html; charset=utf-8", "",
      '<p><a href="https://careers.acme.com/verify?token=abc&amp;x=1">Verify</a> <a href="http://insecure.example/x">no</a> <a href="https://careers.acme.com/privacy">Privacy</a> <a href="javascript:alert(1)">x</a></p>', "--b--", "",
    ].join("\r\n")), new Date()))!;
    expect(m.links).toEqual(["https://careers.acme.com/verify?token=abc&x=1", "https://careers.acme.com/privacy"]);
  });
  it("has none when the message has none", async () => {
    expect((await parseRaw(eml({ "Message-ID": "<n@x.example>", From: "a@x.example", Subject: "hi", "Content-Type": "text/plain" }, "no links here"), new Date()))!.links).toEqual([]);
  });
});

describe("the mailbox reader", () => {
  async function reader(clientOver: object = {}) {
    const dir = mkdtempSync(join(tmpdir(), "jobhunt-imap-"));
    const vault = createVault(dir, { logN: 10 });
    await vault.create(PASS);
    await vault.set("mail.smtp", JSON.stringify({ host: "smtp.gmail.com", port: 465, user: "ada@gmail.com", password: "app pass word" }));
    const calls: string[] = [];
    const searches: unknown[] = [];
    let login: any;
    let lockOptions: unknown;
    const raw = eml({ "Message-ID": "<r1@acme.example>", From: "jane@acme.example", Subject: "Re: x", "In-Reply-To": "<sent1@gmail.com>", "Content-Type": "text/plain" }, "Thanks for applying.");
    const client = {
      connect: async () => { calls.push("connect"); },
      getMailboxLock: async (name: string, o: unknown) => { calls.push(`lock ${name}`); lockOptions = o; return { release: () => calls.push("release") } as never; },
      search: async (q: unknown) => { searches.push(q); return [1, 2]; },
      fetch: async function* () { yield { uid: 1, source: raw, internalDate: new Date("2026-10-07T10:00:00Z") }; yield { uid: 2, source: raw, internalDate: new Date("2026-10-07T10:00:00Z") }; },
      logout: async () => { calls.push("logout"); },
      close: () => { calls.push("close"); },
      ...clientOver,
    };
    const r = createImapReader(vault, { clientFactory: (l) => { login = l; return client as never; } });
    return { r, calls, searches, get login() { return login; }, get lockOptions() { return lockOptions; }, vault };
  }
  const targets = { messageIds: ["sent1@gmail.com", "sent2@gmail.com"], senders: ["acme.example", "jane@gmail.com"], since: new Date("2026-09-01T00:00:00Z") };

  it("opens the inbox read-only, asks only for mail that can belong to an application, and logs out", async () => {
    const t = await reader();
    const out = await t.r.fetch(targets);
    expect(out).toHaveLength(1); // the same message from two searches is one message
    expect(out[0]!.messageId).toBe("<r1@acme.example>");
    expect(t.login).toMatchObject({ host: "imap.gmail.com", port: 993, user: "ada@gmail.com" });
    expect(t.lockOptions).toEqual({ readOnly: true });
    expect(t.calls).toEqual(["connect", "lock INBOX", "release", "logout"]);
    // Replies in our threads (References and In-Reply-To), mail from the companies we wrote to, and delivery failures. Nothing broader.
    expect(t.searches).toEqual([
      { since: targets.since, header: { references: "sent1@gmail.com" } }, { since: targets.since, header: { references: "sent2@gmail.com" } },
      { since: targets.since, header: { "in-reply-to": "sent1@gmail.com" } }, { since: targets.since, header: { "in-reply-to": "sent2@gmail.com" } },
      { since: targets.since, from: "acme.example" }, { since: targets.since, from: "jane@gmail.com" }, { since: targets.since, from: "mailer-daemon" },
    ]);
  });

  it("also asks for mail from the site and mail that says verify, while an account is waiting", async () => {
    const t = await reader();
    await t.r.fetch({ ...targets, verification: { labels: ["acme"], since: new Date("2026-10-01T00:00:00Z") } });
    const since = new Date("2026-10-01T00:00:00Z");
    expect(t.searches.slice(-5)).toEqual([
      { since, from: "acme" }, { since, subject: "verify" }, { since, subject: "confirm" }, { since, subject: "activate" }, { since, subject: "welcome" },
    ]);
    const plain = await reader();
    await plain.r.fetch(targets);
    expect(plain.searches.some((s: any) => s.subject)).toBe(false);
  });

  it("only ever uses the read methods of the mail client: any other method would fail the test", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jobhunt-imap-"));
    const vault = createVault(dir, { logN: 10 });
    await vault.create(PASS);
    await vault.set("mail.smtp", JSON.stringify({ host: "smtp.gmail.com", port: 465, user: "ada@gmail.com", password: "pw" }));
    const allowed = new Set(["connect", "getMailboxLock", "search", "fetch", "logout", "close"]);
    const touched: string[] = [];
    const base: Record<string, unknown> = {
      connect: async () => {}, getMailboxLock: async () => ({ release() {} }), search: async () => [1],
      fetch: async function* () {}, logout: async () => {}, close: () => {},
    };
    const strict = new Proxy(base, { get: (t, k: string) => { touched.push(k); if (!allowed.has(k)) throw new Error(`The reader touched ${k}`); return t[k]; } });
    await createImapReader(vault, { clientFactory: () => strict as never }).fetch(targets);
    expect(touched.every((k) => allowed.has(k))).toBe(true);
    expect(touched).toContain("getMailboxLock");
  });

  it("needs the vault unlocked, and says so plainly when the login is refused or the server is unreachable", async () => {
    const locked = await reader();
    locked.vault.lock();
    await expect(locked.r.fetch(targets)).rejects.toThrow(/Unlock the vault|locked/i);
    const auth = await reader({ connect: async () => { throw Object.assign(new Error("Invalid credentials"), { authenticationFailed: true }); } });
    await expect(auth.r.fetch(targets)).rejects.toThrow(/refused the login.*IMAP/i);
    expect(auth.calls).toContain("close");
    const down = await reader({ connect: async () => { throw Object.assign(new Error("x"), { code: "ENOTFOUND" }); } });
    await expect(down.r.fetch(targets)).rejects.toThrow(/Could not reach the mail server/);
    const other = await reader({ connect: async () => { throw new Error("secret detail with the password app pass word"); } });
    await expect(other.r.fetch(targets)).rejects.toThrow("Checking the mailbox failed");
  });
});

describe("the replies page and its routes", () => {
  let db: DB;
  let server: ReturnType<typeof createApp>;
  let base: string;
  let dataDir: string;
  let sent: any[];
  let inbox: InboundMessage[];
  let fetchError: Error | undefined;
  let fetched: number;

  const auth = { authorization: `Bearer ${TOKEN}` };
  const json = { ...auth, "content-type": "application/json" };
  const get = (p: string) => fetch(base + p, { headers: auth });
  const post = (p: string, b: unknown = {}) => fetch(base + p, { method: "POST", headers: json, body: JSON.stringify(b) });
  const put = (p: string, b: unknown) => fetch(base + p, { method: "PUT", headers: json, body: JSON.stringify(b) });

  beforeEach(async () => {
    db = openDb(":memory:");
    dataDir = mkdtempSync(join(tmpdir(), "jobhunt-rep-"));
    sent = []; inbox = []; fetchError = undefined; fetched = 0;
    const vault = createVault(dataDir, { logN: 10 });
    const fake = { sendMail: async (m: any) => { sent.push(m); return { messageId: `<out${sent.length}@gmail.com>` }; }, close() {} } as never;
    const reader: ImapReader = { fetch: async () => { fetched++; if (fetchError) throw fetchError; return inbox; } };
    server = createApp(db, { token: TOKEN, dataDir, vault, mailer: createMailer(vault, { dryRun: false, transportFactory: () => fake }), replySync: createReplySync(db, reader) });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  async function applied(opts: { vault?: boolean } = {}) {
    setProfile(db, { fullName: "Ada Lovelace", email: "ada@gmail.com", links: [], languages: [] }, H);
    const agent = createAgentApi(db);
    const companyId = agent.upsertCompany({ name: "Acme", domain: "acme.example" });
    const jobId = agent.addCandidateJob({ title: "Backend Engineer", url: "https://acme.example/j/1", canonicalUrl: "https://acme.example/j/1", companyId }).id;
    const fact = addFact(db, { kind: "experience", text: "Built a payments API serving 50000 users" }, H);
    agent.recordVerification(jobId, { result: "live" }); agent.setMatch(jobId, 8, "fits"); agent.setRoute(jobId, "email");
    mkdirSync(join(dataDir, "documents"), { recursive: true });
    writeFileSync(join(dataDir, "documents", "cv.pdf"), "%PDF-1.4 cv");
    saveDocument(db, { jobId, kind: "cv", path: "documents/cv.pdf", blocks: [{ text: "Built a payments API serving 50000 users", factIds: [fact] }] }, "agent");
    saveDocument(db, { jobId, kind: "cover", path: "documents/cv.pdf", blocks: [{ text: "Hello there", factIds: [], kind: "boilerplate" }] }, "agent");
    agent.transitionJob(jobId, "materials_ready");
    const contactId = agent.addContact({ companyId, email: "jane@acme.example", name: "Jane Doe", sourceUrl: "https://acme.example/team" });
    const { emailId } = agent.draftEmail({ jobId, contactId, blocks: [{ text: "Dear Jane,", factIds: [], kind: "boilerplate" }, { text: "I'm applying for the Backend Engineer role at Acme. I built a payments API serving 50000 users. My CV and cover letter are attached.", factIds: [fact] }, { text: "Best regards,", factIds: [], kind: "boilerplate" }] });
    if (opts.vault !== false) {
      await post("/api/vault/create", { passphrase: PASS });
      await put("/api/vault/mail", { password: "abcd wxyz abcd wxyz" });
    }
    const res = await post(`/api/emails/${emailId}/send`);
    return { agent, jobId, emailId, sendStatus: res.status };
  }
  const job = async (id: number) => (await (await get(`/api/jobs/${id}`)).json()).job;

  it("needs the token", async () => {
    expect((await fetch(base + "/api/replies")).status).toBe(401);
    expect((await fetch(base + "/api/replies/sync", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    expect((await fetch(base + "/api/jobs/1/follow-up", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
  });

  it("starts empty and will not open the mailbox without a vault login", async () => {
    const r = await (await get("/api/replies")).json();
    expect(r).toMatchObject({ newCount: 0, messages: [], due: [], canCheck: true, running: false });
    const nope = await post("/api/replies/sync");
    expect(nope.status).toBeGreaterThanOrEqual(400);
    expect(fetched).toBe(0);
  });

  it("checks the mailbox, keeps the reply, moves the job, and shows it on the page and the job", async () => {
    const a = await applied();
    expect(a.sendStatus).toBe(200);
    const messageId = (db.prepare("SELECT message_id FROM emails WHERE id = ?").get(a.emailId) as { message_id: string }).message_id;
    inbox = [
      { messageId: "<r1@acme.example>", inReplyTo: messageId, fromAddr: "jane@acme.example", fromName: "Jane Doe", subject: "Re: Application", receivedAt: new Date().toISOString(), snippet: "Could we schedule a call? What is your availability?" },
      { messageId: "<n1@news.example>", fromAddr: "news@else.example", subject: "Newsletter", receivedAt: new Date().toISOString(), snippet: "Buy things" },
    ];
    const res = await post("/api/replies/sync");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ checked: 2, matched: 1, replies: 1, movedToReplied: 1 });
    const page = await (await get("/api/replies")).json();
    expect(page.newCount).toBe(1);
    expect(page.messages).toEqual([expect.objectContaining({ category: "interview", matchedBy: "thread", jobId: a.jobId, fromAddr: "jane@acme.example" })]);
    expect(page.sync).toMatchObject({ lastChecked: 2, lastMatched: 1 });
    expect((await job(a.jobId)).state).toBe("replied");
    const detail = await (await get(`/api/jobs/${a.jobId}`)).json();
    expect(detail.messages).toHaveLength(1);
  });

  it("records a failed check so the page can say why, and runs one check at a time", async () => {
    await applied();
    fetchError = new Error("The mail server refused the login. Check the app password");
    const bad = await post("/api/replies/sync");
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect((await (await get("/api/replies")).json()).sync.lastError).toMatch(/refused the login/);
    fetchError = undefined;
    expect((await post("/api/replies/sync")).status).toBe(200);
    expect((await (await get("/api/replies")).json()).sync.lastError).toBeUndefined();
  });

  it("lets the user mark, re-categorize and decide what a reply means", async () => {
    const a = await applied();
    const messageId = (db.prepare("SELECT message_id FROM emails WHERE id = ?").get(a.emailId) as { message_id: string }).message_id;
    inbox = [{ messageId: "<r1@acme.example>", inReplyTo: messageId, fromAddr: "jane@acme.example", subject: "Re", receivedAt: new Date().toISOString(), snippet: "Thanks for your application." }];
    await post("/api/replies/sync");
    const id = (await (await get("/api/replies")).json()).messages[0].id;
    expect((await post(`/api/messages/${id}`, { category: "rejection" })).status).toBe(200);
    expect((await post(`/api/messages/${id}`, { category: "nonsense" })).status).toBeGreaterThanOrEqual(400);
    expect((await post(`/api/messages/${id}/outcome`, { to: "banana" })).status).toBe(400);
    expect((await post(`/api/messages/${id}/outcome`, { to: "interview" })).status).toBe(200);
    expect((await job(a.jobId)).state).toBe("interview");
    const page = await (await get("/api/replies")).json();
    expect(page.messages[0]).toMatchObject({ status: "handled", category: "rejection" });
    expect(page.newCount).toBe(0);
  });

  it("drafts a follow-up in the same thread and sends it with the thread headers and no attachments", async () => {
    const a = await applied();
    const originalId = (db.prepare("SELECT message_id FROM emails WHERE id = ?").get(a.emailId) as { message_id: string }).message_id;
    const draft = await post(`/api/jobs/${a.jobId}/follow-up`);
    expect(draft.status).toBe(200);
    const { emailId } = await draft.json();
    const e = await (await get(`/api/emails/${emailId}`)).json();
    expect(e).toMatchObject({ kind: "follow_up", inReplyTo: originalId, status: "draft" });
    expect(e.subject.startsWith("Re: ")).toBe(true);
    const before = sent.length;
    const res = await post(`/api/emails/${emailId}/send`);
    expect(res.status).toBe(200);
    const msg = sent[before];
    expect(msg).toMatchObject({ inReplyTo: originalId, references: [originalId] });
    expect(msg.attachments).toEqual([]);
    expect((await job(a.jobId)).state).toBe("applied");
    expect((await post(`/api/jobs/${a.jobId}/follow-up`)).status).toBeGreaterThanOrEqual(400); // the one allowed follow-up is used
  });

  it("finds the verification mail for a waiting account and shows it, then verifies on the user's word", async () => {
    setProfile(db, { fullName: "Ada Lovelace", email: "ada@gmail.com", links: [], languages: [] }, H);
    await post("/api/vault/create", { passphrase: PASS });
    await put("/api/vault/mail", { password: "abcd wxyz abcd wxyz" });
    const { id } = await (await post("/api/accounts/start", { site: "https://careers.acme.com/signup" })).json();
    inbox = [
      { messageId: "<v1@mail.example>", fromAddr: "noreply@careers.acme.com", subject: "Please verify your email address", receivedAt: new Date().toISOString(), snippet: "Click to verify your email.", links: ["https://careers.acme.com/verify?token=abc"] },
      { messageId: "<n1@news.example>", fromAddr: "news@else.example", subject: "Sale", receivedAt: new Date().toISOString(), snippet: "Buy" },
    ];
    const r = await (await post("/api/replies/sync")).json();
    expect(r).toMatchObject({ verifications: 1 });
    const list = await (await get("/api/verifications")).json();
    expect(list).toEqual([expect.objectContaining({ accountId: id, status: "new", link: "https://careers.acme.com/verify?token=abc", linkRelated: true })]);
    const card = (await (await get("/api/actions")).json()).find((a: any) => a.payload.mode === "verify");
    expect(card.payload).toMatchObject({ site: "careers.acme.com", linkHost: "careers.acme.com" });
    expect((await post(`/api/verifications/${list[0].id}/used`)).status).toBe(200);
    expect((await (await get("/api/accounts")).json())[0]).toMatchObject({ status: "verified" });
    expect((await (await get("/api/verifications")).json())[0]).toMatchObject({ status: "used" });
    expect((await (await get("/api/actions")).json()).filter((a: any) => a.payload.mode === "verify")).toHaveLength(0);
  });

  it("does not open the mailbox when nothing is waiting and nothing has been sent", async () => {
    setProfile(db, { fullName: "Ada Lovelace", email: "ada@gmail.com", links: [], languages: [] }, H);
    await post("/api/vault/create", { passphrase: PASS });
    await put("/api/vault/mail", { password: "abcd wxyz abcd wxyz" });
    const r = await (await post("/api/replies/sync")).json();
    expect(r.skipped).toMatch(/nothing to look for/);
    expect(fetched).toBe(0);
  });

  it("saves the follow-up settings and refuses a nonsense value", async () => {
    const body = { roles: [], remotePolicy: "any", dailyApplicationLimit: 5, dailyDiscoveryLimit: 5 };
    expect((await put("/api/preferences", { ...body, followUpDays: 5, maxFollowUps: 2, noResponseDays: 30, autoMarkReplied: false, replyCheckMinutes: 10, replySnippetDays: 60 })).status).toBe(200);
    expect(await (await get("/api/preferences")).json()).toMatchObject({ followUpDays: 5, maxFollowUps: 2, noResponseDays: 30, autoMarkReplied: false, replyCheckMinutes: 10, replySnippetDays: 60 });
    expect((await put("/api/preferences", { ...body, followUpDays: 0 })).status).toBeGreaterThanOrEqual(400);
    expect((await put("/api/preferences", { ...body, followUpDays: 10, noResponseDays: 5 })).status).toBeGreaterThanOrEqual(400);
  });
});
