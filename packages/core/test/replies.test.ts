import { describe, expect, it } from "vitest";
import {
  addFact, applyMessageOutcome, beginSend, classifyMessage, createAgentApi, discardEmail, draftFollowUp, dueFollowUps, finishSend, getEmail,
  ingestMessages, listMessages, matchMessage, newMessageCount, openDb, purgeOldSnippets, saveDocument, scanFollowUps, setMessageCategory,
  setMessageStatus, setPreferences, setProfile, transitionJob, type DB, type InboundMessage,
} from "../src/index.js";

const H = "human" as const;
const throws = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as Error).message; } return ""; };
const prefs = (over: object = {}) => ({ roles: [], seniority: [], locations: [], remotePolicy: "any" as const, industries: [], exclusions: [], dailyApplicationLimit: 5, dailyDiscoveryLimit: 5, searchAnySite: true, ...over });
const DAY = 86_400_000;

const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  messageId: `<m${Math.random().toString(36).slice(2)}@mail.acme.example>`, fromAddr: "jane@acme.example", fromName: "Jane Doe", subject: "Re: Application: Backend Engineer, Ada Lovelace",
  receivedAt: new Date().toISOString(), snippet: "Thanks for applying. We would like to learn more about your work.", ...over,
});

/** A job applied for by email: the email was drafted and sent, and the server stored its Message-ID. */
function applied(db: DB, n = 1, domain = "acme.example", messageId = `<sent${n}@gmail.com>`) {
  const agent = createAgentApi(db);
  const co = agent.upsertCompany({ name: `Acme ${n}`, domain });
  const jobId = agent.addCandidateJob({ title: "Backend Engineer II", url: `https://${domain}/j/${n}`, canonicalUrl: `https://${domain}/j/${n}`, companyId: co }).id;
  agent.recordVerification(jobId, { result: "live" }); agent.setMatch(jobId, 8, "fits"); agent.setRoute(jobId, "email");
  const fact = addFact(db, { kind: "experience", text: `Built a payments API serving ${n}0000 users` }, H);
  saveDocument(db, { jobId, kind: "cv", path: "documents/cv.pdf", blocks: [{ text: `Built a payments API serving ${n}0000 users`, factIds: [fact] }] }, "agent");
  agent.transitionJob(jobId, "materials_ready");
  const contactId = agent.addContact({ companyId: co, email: `jane@${domain}`, name: "Jane Doe", sourceUrl: `https://${domain}/team` });
  const { emailId } = agent.draftEmail({ jobId, contactId, blocks: [{ text: "Dear Jane,", factIds: [], kind: "boilerplate" }, { text: `I'm applying for the Backend Engineer role at Acme. I built a payments API serving ${n}0000 users.`, factIds: [fact] }, { text: "Best regards,", factIds: [], kind: "boilerplate" }] });
  beginSend(db, emailId, H);
  finishSend(db, emailId, messageId, H);
  return { agent, jobId, contactId, emailId, messageId, co };
}
const state = (db: DB, id: number) => (db.prepare("SELECT state FROM jobs WHERE id = ?").get(id) as { state: string }).state;
const ago = (db: DB, jobId: number, days: number) => {
  const t = new Date(Date.now() - days * DAY).toISOString().slice(0, 19).replace("T", " ");
  db.prepare("UPDATE emails SET sent_at = ? WHERE job_id = ? AND status = 'sent'").run(t, jobId);
  db.prepare("UPDATE applications SET sent_at = ? WHERE job_id = ?").run(t, jobId);
};
function setup() {
  const db = openDb(":memory:");
  setProfile(db, { fullName: "Ada Lovelace", email: "ada@gmail.com", links: [], languages: [] }, H);
  setPreferences(db, prefs(), H);
  return db;
}

describe("classifyMessage", () => {
  const c = (o: Partial<InboundMessage>) => classifyMessage({ fromAddr: "jane@acme.example", subject: "Hello", snippet: "", ...o });
  it("tells people from machines", () => {
    expect(c({ fromAddr: "MAILER-DAEMON@googlemail.com", subject: "Delivery Status Notification (Failure)" })).toBe("bounce");
    expect(c({ failedRecipient: "x@acme.example" })).toBe("bounce");
    expect(c({ subject: "Out of office: back Monday" })).toBe("auto_reply");
    expect(c({ autoSubmitted: "auto-replied" })).toBe("auto_reply");
    expect(c({ autoSubmitted: "no" })).toBe("reply");
    expect(c({ precedence: "bulk" })).toBe("auto_reply");
    expect(c({ xAutoreply: true })).toBe("auto_reply");
  });
  it("suggests rejection and interview from the words", () => {
    expect(c({ snippet: "Unfortunately we have decided not to move forward." })).toBe("rejection");
    expect(c({ snippet: "We have decided to proceed with other candidates." })).toBe("rejection");
    expect(c({ snippet: "Could we schedule a call this week? What is your availability?" })).toBe("interview");
    expect(c({ snippet: "Thanks for sending this over, I have passed it to the team." })).toBe("reply");
  });
  it("lets a bounce win over everything and an automatic reply over a person's words", () => {
    expect(c({ failedRecipient: "x@y.z", snippet: "interview" })).toBe("bounce");
    expect(c({ subject: "Automatic reply", snippet: "unfortunately I am away" })).toBe("auto_reply");
  });
});

describe("matchMessage", () => {
  const sent = [{ emailId: 1, jobId: 1, contactId: 1, contactEmail: "jane@acme.example", messageId: "sent1@gmail.com", state: "applied" as const }];
  it("is certain when the reply names our message", () => {
    expect(matchMessage(msg({ inReplyTo: "<SENT1@gmail.com>", fromAddr: "someone@else.example" }), sent)).toMatchObject({ by: "thread" });
    expect(matchMessage(msg({ references: ["<a@b>", "<sent1@gmail.com>"], fromAddr: "someone@else.example" }), sent)).toMatchObject({ by: "thread" });
  });
  it("suggests by sender: the contact, or another person at the company", () => {
    expect(matchMessage(msg({ fromAddr: "JANE@acme.example" }), sent)).toMatchObject({ by: "sender" });
    expect(matchMessage(msg({ fromAddr: "recruiter@jobs.acme.example" }), sent)).toMatchObject({ by: "sender" });
  });
  it("ignores everything else, including other people on a free mail domain", () => {
    expect(matchMessage(msg({ fromAddr: "news@other.example" }), sent)).toBeUndefined();
    expect(matchMessage(msg({ fromAddr: "friend@gmail.com" }), sent)).toBeUndefined();
    const free = [{ ...sent[0]!, contactEmail: "jane@gmail.com" }];
    expect(matchMessage(msg({ fromAddr: "other@gmail.com" }), free)).toBeUndefined();
    expect(matchMessage(msg({ fromAddr: "jane@gmail.com" }), free)).toMatchObject({ by: "sender" });
  });
  it("does not suggest a job that is not waiting for an answer", () => {
    expect(matchMessage(msg({ fromAddr: "jane@acme.example" }), [{ ...sent[0]!, state: "interview" as never }, { ...sent[0]!, state: "dead" as never }].slice(1))).toBeUndefined();
  });
  it("matches a delivery failure by the address that failed", () => {
    expect(matchMessage(msg({ fromAddr: "mailer-daemon@googlemail.com", failedRecipient: "Jane@Acme.example" }), sent)).toMatchObject({ by: "sender" });
  });
});

describe("ingestMessages", () => {
  it("keeps a reply in the thread and moves the job to replied", () => {
    const db = setup();
    const a = applied(db);
    const r = ingestMessages(db, [msg({ inReplyTo: a.messageId })], H);
    expect(r).toMatchObject({ checked: 1, matched: 1, replies: 1, movedToReplied: 1 });
    expect(state(db, a.jobId)).toBe("replied");
    expect(listMessages(db)[0]).toMatchObject({ jobId: a.jobId, category: "reply", matchedBy: "thread", status: "new", jobTitle: expect.stringContaining("Backend Engineer") });
    expect(newMessageCount(db)).toBe(1);
  });

  it("does not move the job when the setting is off, or when the match is only by sender", () => {
    const db = setup();
    const a = applied(db);
    setPreferences(db, prefs({ autoMarkReplied: false }), H);
    ingestMessages(db, [msg({ inReplyTo: a.messageId })], H);
    expect(state(db, a.jobId)).toBe("applied");
    const db2 = setup();
    const b = applied(db2);
    ingestMessages(db2, [msg()], H);
    expect(state(db2, b.jobId)).toBe("applied");
    expect(listMessages(db2)[0]!.matchedBy).toBe("sender");
  });

  it("stores nothing that does not belong to an application, and nothing twice", () => {
    const db = setup();
    const a = applied(db);
    const mine = msg({ inReplyTo: a.messageId });
    const r = ingestMessages(db, [mine, msg({ fromAddr: "spam@else.example" }), msg({ fromAddr: "friend@gmail.com" })], H);
    expect(r).toMatchObject({ checked: 3, matched: 1 });
    expect(ingestMessages(db, [mine], H).matched).toBe(0);
    expect(listMessages(db)).toHaveLength(1);
  });

  it("marks a bounced contact, queues a note, and leaves the job alone", () => {
    const db = setup();
    const a = applied(db);
    const r = ingestMessages(db, [msg({ fromAddr: "mailer-daemon@googlemail.com", subject: "Delivery Status Notification (Failure)", failedRecipient: "jane@acme.example" })], H);
    expect(r.bounces).toBe(1);
    expect((db.prepare("SELECT status FROM contacts WHERE id = ?").get(a.contactId) as { status: string }).status).toBe("bounced");
    expect(state(db, a.jobId)).toBe("applied");
    expect(a.agent.listOpenActions().some((x: any) => x.kind === "follow_up" && JSON.parse(x.payload).reason === "bounce")).toBe(true);
  });

  it("keeps an automatic reply without treating it as an answer", () => {
    const db = setup();
    const a = applied(db);
    ingestMessages(db, [msg({ inReplyTo: a.messageId, subject: "Automatic reply: Application", autoSubmitted: "auto-replied" })], H);
    expect(state(db, a.jobId)).toBe("applied");
    expect(listMessages(db)[0]!.category).toBe("auto_reply");
    expect(newMessageCount(db)).toBe(0);
  });

  it("only suggests a rejection or an interview; the user decides", () => {
    const db = setup();
    const a = applied(db);
    ingestMessages(db, [msg({ inReplyTo: a.messageId, snippet: "Unfortunately we will not be moving forward." })], H);
    expect(listMessages(db)[0]!.category).toBe("rejection");
    expect(state(db, a.jobId)).toBe("replied");
  });

  it("cancels a pending follow-up reminder when a reply arrives", () => {
    const db = setup();
    const a = applied(db);
    ago(db, a.jobId, 10);
    scanFollowUps(db);
    expect(a.agent.listOpenActions().filter((x: any) => x.kind === "follow_up")).toHaveLength(1);
    ingestMessages(db, [msg({ inReplyTo: a.messageId })], H);
    expect(a.agent.listOpenActions().filter((x: any) => x.kind === "follow_up")).toHaveLength(0);
  });

  it("trims the snippet and the subject", () => {
    const db = setup();
    const a = applied(db);
    ingestMessages(db, [msg({ inReplyTo: a.messageId, snippet: "word ".repeat(400), subject: "a\n  b" })], H);
    const m = listMessages(db)[0]!;
    expect(m.snippet.length).toBeLessThanOrEqual(500);
    expect(m.subject).toBe("a b");
  });
});

describe("what the user does with a reply", () => {
  it("handles, re-categorizes and records the outcome, and only a human can", () => {
    const db = setup();
    const a = applied(db);
    ingestMessages(db, [msg({ inReplyTo: a.messageId, snippet: "Could we schedule a call? What is your availability?" })], H);
    const id = listMessages(db)[0]!.id;
    expect(listMessages(db)[0]!.category).toBe("interview");
    setMessageCategory(db, id, "reply", H);
    expect(listMessages(db)[0]!.category).toBe("reply");
    expect(throws(() => setMessageStatus(db, id, "handled", "agent"))).toMatch(/Only the user/);
    applyMessageOutcome(db, id, "interview", H);
    expect(state(db, a.jobId)).toBe("interview");
    expect(listMessages(db)[0]!.status).toBe("handled");
    expect(throws(() => setMessageStatus(db, 999, "handled", H))).toMatch(/not found/);
  });
  it("moves an applied job to replied and then to rejected when the user says so", () => {
    const db = setup();
    const a = applied(db);
    ingestMessages(db, [msg()], H); // sender match only: the job stays applied
    expect(state(db, a.jobId)).toBe("applied");
    applyMessageOutcome(db, listMessages(db)[0]!.id, "rejected", H);
    expect(state(db, a.jobId)).toBe("rejected");
  });
});

describe("follow-ups", () => {
  it("is due after the chosen days, and not before", () => {
    const db = setup();
    const a = applied(db);
    ago(db, a.jobId, 3);
    expect(dueFollowUps(db)).toEqual([]);
    ago(db, a.jobId, 8);
    expect(dueFollowUps(db)).toEqual([expect.objectContaining({ jobId: a.jobId, route: "email", daysSince: 8, followUpsSent: 0 })]);
    setPreferences(db, prefs({ followUpDays: 14 }), H);
    expect(dueFollowUps(db)).toEqual([]);
  });

  it("is not due after a reply, or when follow-ups are set to zero", () => {
    const db = setup();
    const a = applied(db);
    ago(db, a.jobId, 10);
    setPreferences(db, prefs({ maxFollowUps: 0 }), H);
    expect(dueFollowUps(db)).toEqual([]);
    setPreferences(db, prefs(), H);
    ingestMessages(db, [msg({ fromAddr: "jane@acme.example" })], H);
    expect(dueFollowUps(db)).toEqual([]);
  });

  it("queues one reminder per job however often it scans", () => {
    const db = setup();
    const a = applied(db);
    ago(db, a.jobId, 10);
    expect(scanFollowUps(db).queued).toBe(1);
    expect(scanFollowUps(db).queued).toBe(0);
    const q = a.agent.listOpenActions().find((x: any) => x.kind === "follow_up") as any;
    expect(JSON.parse(q.payload)).toMatchObject({ reason: "no_reply", days: 10 });
  });

  it("marks a job no_response after the quiet period, and not when the period is zero", () => {
    const db = setup();
    const a = applied(db);
    ago(db, a.jobId, 25);
    setPreferences(db, prefs({ noResponseDays: 0 }), H);
    expect(scanFollowUps(db).markedNoResponse).toBe(0);
    expect(state(db, a.jobId)).toBe("applied");
    setPreferences(db, prefs({ noResponseDays: 21 }), H);
    expect(scanFollowUps(db).markedNoResponse).toBe(1);
    expect(state(db, a.jobId)).toBe("no_response");
    expect(a.agent.listOpenActions().filter((x: any) => x.kind === "follow_up")).toHaveLength(0);
  });

  it("rejects a quiet period shorter than the follow-up delay", () => {
    const db = setup();
    expect(throws(() => setPreferences(db, prefs({ followUpDays: 10, noResponseDays: 5 }), H))).toMatch(/later than/);
    expect(throws(() => setPreferences(db, prefs({ followUpDays: 0 }), H))).toMatch(/1 to 90/);
    expect(throws(() => setPreferences(db, prefs({ maxFollowUps: 9 }), H))).toMatch(/0 to 5/);
  });

  it("reminds once about a form application, pointing at the portal", () => {
    const db = setup();
    const agent = createAgentApi(db);
    const jobId = agent.addCandidateJob({ title: "Engineer", url: "https://a.io/1", canonicalUrl: "https://a.io/1" }).id;
    agent.recordVerification(jobId, { result: "live" }); agent.setMatch(jobId, 8, "fits"); agent.setRoute(jobId, "form");
    saveDocument(db, { jobId, kind: "cv", path: "documents/cv.pdf", blocks: [{ text: "Hello there", factIds: [], kind: "boilerplate" }] }, "agent");
    agent.transitionJob(jobId, "materials_ready"); agent.transitionJob(jobId, "awaiting_approval"); transitionJob(db, jobId, "applied", H);
    db.prepare("INSERT INTO applications (job_id, route, status, sent_at) VALUES (?, 'form', 'submitted', datetime('now', '-9 days'))").run(jobId);
    expect(dueFollowUps(db)).toEqual([expect.objectContaining({ route: "form" })]);
    expect(scanFollowUps(db).queued).toBe(1);
    db.prepare("UPDATE action_queue SET status = 'done' WHERE kind = 'follow_up'").run();
    expect(dueFollowUps(db)).toEqual([]);
  });
});

describe("drafting a follow-up", () => {
  it("writes a short reminder in the same thread, attaches nothing, and sends like any email", () => {
    const db = setup();
    const a = applied(db);
    const { emailId } = draftFollowUp(db, a.jobId, H);
    const e = getEmail(db, emailId)!;
    expect(e).toMatchObject({ kind: "follow_up", inReplyTo: a.messageId, status: "draft", attachment: undefined, coverAttachment: undefined });
    expect(e.subject).toBe("Re: Application: Backend Engineer II, Ada Lovelace");
    expect(e.bodyText).toContain("Dear Jane,");
    expect(e.bodyText).toContain("follow up on my application for the Backend Engineer II position at Acme");
    expect(a.agent.listOpenActions().some((x: any) => x.kind === "approve_email" && JSON.parse(x.payload).followUp === true)).toBe(true);
    const before = db.prepare("SELECT sent_at FROM applications WHERE job_id = ?").get(a.jobId);
    beginSend(db, emailId, H);
    finishSend(db, emailId, "<follow1@gmail.com>", H);
    expect(db.prepare("SELECT sent_at FROM applications WHERE job_id = ?").get(a.jobId)).toEqual(before);
    expect(state(db, a.jobId)).toBe("applied");
    expect(getEmail(db, emailId)!.status).toBe("sent");
  });

  it("does not count toward the daily limit, and a discarded one leaves the job alone", () => {
    const db = setup();
    setPreferences(db, prefs({ dailyApplicationLimit: 1 }), H);
    const a = applied(db);
    const { emailId } = draftFollowUp(db, a.jobId, H);
    expect((db.prepare("SELECT COUNT(*) AS n FROM emails WHERE kind = 'application' AND status IN ('draft','sending','failed')").get() as { n: number }).n).toBe(0);
    discardEmail(db, emailId, H);
    expect(state(db, a.jobId)).toBe("applied");
  });

  it("refuses when it should: wrong state, a draft already open, the maximum reached, a bounce, or not a human", () => {
    const db = setup();
    const a = applied(db);
    expect(throws(() => draftFollowUp(db, a.jobId, "agent"))).toMatch(/Only the user/);
    expect(throws(() => draftFollowUp(db, 999, H))).toMatch(/not found/);
    const { emailId } = draftFollowUp(db, a.jobId, H);
    expect(throws(() => draftFollowUp(db, a.jobId, H))).toMatch(/already a follow-up draft/);
    beginSend(db, emailId, H); finishSend(db, emailId, "<f1@gmail.com>", H);
    expect(throws(() => draftFollowUp(db, a.jobId, H))).toMatch(/most allowed/);
    setPreferences(db, prefs({ maxFollowUps: 2 }), H);
    db.prepare("UPDATE contacts SET status = 'bounced' WHERE id = ?").run(a.contactId);
    expect(throws(() => draftFollowUp(db, a.jobId, H))).toMatch(/bounced/);
    const other = a.agent.addCandidateJob({ title: "Other", url: "https://o.io/1", canonicalUrl: "https://o.io/1" }).id;
    expect(throws(() => draftFollowUp(db, other, H))).toMatch(/has gone out/);
  });
});

describe("keeping messages", () => {
  it("removes the text of old messages and keeps the rest", () => {
    const db = setup();
    const a = applied(db);
    ingestMessages(db, [msg({ inReplyTo: a.messageId, receivedAt: new Date(Date.now() - 100 * DAY).toISOString() }), msg({ inReplyTo: a.messageId })], H);
    expect(purgeOldSnippets(db)).toBe(1);
    const rows = listMessages(db);
    expect(rows.map((r) => r.snippet === "")).toEqual([false, true]);
    expect(rows).toHaveLength(2);
  });
});
