import { describe, expect, it } from "vitest";
import {
  addContact, addFact, applicationsToday, beginSend, createAgentApi, createHumanApi, discardEmail, draftEmail, failSend, finishSend,
  getEmail, isPrivateAddress, listContacts, listOpenActions, markContactBounced, openDb, pageShowsEmail, saveDocument, setProfile,
  updateEmail, verifyContact, type VerifyDeps,
} from "../src/index.js";

const H = "human" as const;

const setup = (opts: { domain?: string | null } = {}) => {
  const db = openDb(":memory:");
  setProfile(db, { fullName: "Ada Lovelace", email: "ada@example.com", phone: "0911", links: [], languages: [] }, H);
  const agent = createAgentApi(db);
  const companyId = agent.upsertCompany({ name: "Acme", domain: opts.domain === null ? undefined : (opts.domain ?? "acme.example") });
  const { id: jobId } = agent.addCandidateJob({ title: "Backend Engineer", url: "https://acme.example/j/1", canonicalUrl: "https://acme.example/j/1", companyId });
  const fact = addFact(db, { kind: "experience", text: "Built a payments API serving 50000 users" }, H);
  agent.recordVerification(jobId, { result: "live" });
  agent.setMatch(jobId, 8, "fits");
  agent.setRoute(jobId, "email");
  const cv = saveDocument(db, { jobId, kind: "cv", path: "documents/job-1-cv-v1.pdf", blocks: [{ text: "Built a payments API serving 50000 users", factIds: [fact] }] }, "agent");
  agent.transitionJob(jobId, "materials_ready", "CV built");
  const contactId = agent.addContact({ companyId, email: "Jobs@Acme.example", sourceUrl: "https://acme.example/careers" });
  const blocks = [
    { text: "Dear hiring team,", factIds: [], kind: "boilerplate" as const },
    { text: "I built a payments API serving 50000 users and would like to apply for the Backend Engineer role.", factIds: [fact] },
    { text: "Best regards,", factIds: [], kind: "boilerplate" as const },
  ];
  return { db, agent, human: createHumanApi(db), companyId, jobId, fact, cv, contactId, blocks };
};

const throws = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as Error).message; } return ""; };

describe("pageShowsEmail", () => {
  const cf = (email: string, key = 0x42) => [key, ...[...email].map((c) => c.charCodeAt(0) ^ key)].map((n) => n.toString(16).padStart(2, "0")).join("");
  it("finds an address however the page writes it", () => {
    const e = "hr@acme.example";
    for (const html of [
      "Write to hr@acme.example today",
      `<a href="mailto:HR@Acme.Example?subject=Hi">email us</a>`,
      "hr&#64;acme&#46;example",
      "hr&#x40;acme.example",
      "hr&commat;acme&period;example",
      "mailto:hr%40acme.example",
      "hr [at] acme [dot] example",
      "hr(at)acme(dot)example",
      `<a class="__cf_email__" data-cfemail="${cf(e)}">[email&#160;protected]</a>`,
      `<a href="/cdn-cgi/l/email-protection#${cf(e, 0x7a)}">x</a>`,
    ]) expect(pageShowsEmail(html, e), html).toBe(true);
  });
  it("does not accept a different address that merely contains it", () => {
    for (const html of ["xhr@acme.example", "hr@acme.example.au", "hr@acme.examples", "hr@acme.example.evil.com", "no email here", "hr at acme"]) {
      expect(pageShowsEmail(html, "hr@acme.example"), html).toBe(false);
    }
    expect(pageShowsEmail("Contact: hr@acme.example.", "hr@acme.example")).toBe(true); // end of a sentence
  });
});

describe("isPrivateAddress", () => {
  it("blocks local, private and reserved addresses, and allows public ones", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "172.31.255.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "not-an-ip"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe("verifyContact", () => {
  const deps = (over: Partial<VerifyDeps> = {}): VerifyDeps => ({
    hasMail: async () => true,
    fetchPage: async () => "<p>Apply at jobs@acme.example</p>",
    ...over,
  });

  it("accepts an address that is on the page and whose domain takes mail", async () => {
    expect(await verifyContact({ email: " Jobs@Acme.example ", sourceUrl: "https://acme.example/careers" }, deps())).toEqual({ ok: true, email: "jobs@acme.example" });
  });

  it("refuses a guessed address and tells the agent to search again", async () => {
    const r = await verifyContact({ email: "careers@acme.example", sourceUrl: "https://acme.example/careers" }, deps());
    expect(r).toMatchObject({ ok: false });
    expect((r as any).reason).toMatch(/does not appear on https:\/\/acme.example\/careers. Search again.*never guess/);
  });

  it("refuses bad addresses, domains with no mail, and pages it cannot read", async () => {
    expect((await verifyContact({ email: "nobody", sourceUrl: "https://a.io" }, deps()) as any).reason).toMatch(/not a valid email/);
    expect((await verifyContact({ email: "a@nomail.example", sourceUrl: "https://a.io" }, deps({ hasMail: async () => false })) as any).reason).toMatch(/no mail records/);
    expect((await verifyContact({ email: "a@b.example", sourceUrl: "https://a.io" }, deps({ hasMail: async () => { throw new Error("could not look the domain up right now"); } })) as any).reason).toMatch(/right now/);
    expect((await verifyContact({ email: "jobs@acme.example", sourceUrl: "https://a.io" }, deps({ fetchPage: async () => { throw new Error("the page returned 404"); } })) as any).reason).toMatch(/Could not read https:\/\/a.io: the page returned 404/);
  });

  it("checks only the domain when there is no source page (an address the user typed)", async () => {
    let fetched = 0;
    const r = await verifyContact({ email: "me@acme.example" }, deps({ fetchPage: async () => { fetched++; return ""; } }));
    expect(r.ok).toBe(true);
    expect(fetched).toBe(0);
  });
});

describe("contacts", () => {
  it("the agent must say where it found an address; the user need not; duplicates are merged", () => {
    const s = setup();
    expect(throws(() => s.agent.addContact({ companyId: s.companyId, email: "x@acme.example", sourceUrl: "nope" }))).toMatch(/needs the page it was found on/);
    expect(throws(() => s.agent.addContact({ companyId: 999, email: "x@acme.example", sourceUrl: "https://a.io" }))).toMatch(/not found/);
    expect(throws(() => s.agent.addContact({ companyId: s.companyId, email: "bad", sourceUrl: "https://a.io" }))).toMatch(/not a valid/);
    const mine = s.human.addContact({ companyId: s.companyId, email: "me@acme.example", name: "Sam", role: "Recruiter" });
    expect(s.human.getContact(mine)).toMatchObject({ addedBy: "user", sourceUrl: "entered by the user", name: "Sam" });
    expect(s.agent.addContact({ companyId: s.companyId, email: "jobs@acme.example", sourceUrl: "https://acme.example/other" })).toBe(s.contactId);
    expect(listContacts(s.db, s.companyId)).toHaveLength(2);
  });

  it("only the user can mark one bounced, and the agent then cannot draft to it", () => {
    const s = setup();
    expect(throws(() => markContactBounced(s.db, s.contactId, "agent"))).toMatch(/Only the user/);
    s.human.markContactBounced(s.contactId);
    expect(throws(() => s.agent.draftEmail({ jobId: s.jobId, contactId: s.contactId, blocks: s.blocks }))).toMatch(/bounced/);
  });

  it("records when no contact could be found", () => {
    const s = setup();
    s.agent.noContactFound(s.jobId, "Only a contact form on the site");
    const events = s.agent.getJob(s.jobId)!.events as any[];
    expect(events[0]).toMatchObject({ actor: "agent", type: "no_contact_found", detail: { detail: "Only a contact form on the site" } });
    expect(throws(() => s.agent.noContactFound(999))).toMatch(/not found/);
  });
});

describe("drafting", () => {
  it("saves the draft, attaches the latest CV, queues it for the user and moves the job", () => {
    const s = setup();
    const { emailId, documentId } = s.agent.draftEmail({ jobId: s.jobId, contactId: s.contactId, blocks: s.blocks });
    const e = getEmail(s.db, emailId)!;
    expect(e).toMatchObject({ status: "draft", subject: "Application: Backend Engineer, Ada Lovelace", edited: false, attachment: { documentId: s.cv.id, version: 1 } });
    expect(e.contact.email).toBe("jobs@acme.example");
    expect(e.bodyText).toBe("Dear hiring team,\n\nI built a payments API serving 50000 users and would like to apply for the Backend Engineer role.\n\nBest regards,\nAda Lovelace\n0911\nada@example.com");
    expect(s.agent.getDocument(documentId)).toMatchObject({ kind: "email", version: 1 });
    const open = listOpenActions(s.db) as any[];
    expect(open.map((a) => a.kind)).toEqual(["approve_email"]);
    expect(JSON.parse(open[0].payload)).toMatchObject({ emailId, to: "jobs@acme.example" });
    expect(s.agent.getJob(s.jobId)!.job.state).toBe("awaiting_approval");
  });

  it("refuses when the job, contact, CV or wording is not right", () => {
    const s = setup();
    const draft = (over: object = {}) => throws(() => s.agent.draftEmail({ jobId: s.jobId, contactId: s.contactId, blocks: s.blocks, ...over }));
    expect(draft({ jobId: 999 })).toMatch(/not found/);
    expect(draft({ contactId: 999 })).toMatch(/Contact 999 not found/);
    expect(draft({ subject: "Hi\r\nBcc: evil@x.example" })).toMatch(/one line/);
    expect(draft({ blocks: [{ text: "I served 90000 users", factIds: [s.fact] }] })).toMatch(/90000/);
    expect(draft({ blocks: [{ text: "I led a big team", factIds: [] }] })).toMatch(/cites no fact/);
    const other = s.agent.upsertCompany({ name: "Other", domain: "other.example" });
    const stranger = s.agent.addContact({ companyId: other, email: "hr@other.example", sourceUrl: "https://other.example/c" });
    expect(draft({ contactId: stranger })).toMatch(/different company/);
    expect(listOpenActions(s.db)).toHaveLength(0); // every refusal left nothing behind
    expect(s.agent.getJob(s.jobId)!.job.state).toBe("materials_ready");
  });

  it("needs route email, a finished CV, and allows only one open draft per contact", () => {
    const s = setup();
    s.agent.setRoute(s.jobId, "form");
    expect(throws(() => s.agent.draftEmail({ jobId: s.jobId, contactId: s.contactId, blocks: s.blocks }))).toMatch(/does not apply by email/);
    s.agent.setRoute(s.jobId, "email");
    s.agent.draftEmail({ jobId: s.jobId, contactId: s.contactId, blocks: s.blocks });
    expect(throws(() => s.agent.draftEmail({ jobId: s.jobId, contactId: s.contactId, blocks: s.blocks }))).toMatch(/materials_ready/);

    const t = setup();
    t.db.prepare("DELETE FROM documents WHERE kind = 'cv'").run();
    expect(throws(() => t.agent.draftEmail({ jobId: t.jobId, contactId: t.contactId, blocks: t.blocks }))).toMatch(/no CV/);
  });

  it("flags an address on another domain, and one that cannot be compared", () => {
    const s = setup();
    const odd = s.agent.addContact({ companyId: s.companyId, email: "jobs@evil.example", sourceUrl: "https://acme.example/careers" });
    const sub = s.agent.addContact({ companyId: s.companyId, email: "hr@mail.acme.example", sourceUrl: "https://acme.example/careers" });
    const free = s.agent.addContact({ companyId: s.companyId, email: "acme.jobs@gmail.com", sourceUrl: "https://acme.example/careers" });
    const flags = (contactId: number) => {
      const { emailId } = s.agent.draftEmail({ jobId: s.jobId, contactId, blocks: s.blocks });
      const e = getEmail(s.db, emailId)!;
      discardEmail(s.db, emailId, H);
      return [e.domainMismatch, e.domainUnclear];
    };
    expect(flags(s.contactId)).toEqual([false, false]);
    expect(flags(odd)).toEqual([true, false]);
    expect(flags(sub)).toEqual([false, false]);
    expect(flags(free)).toEqual([false, true]);
    const s2 = setup({ domain: null });
    const { emailId } = s2.agent.draftEmail({ jobId: s2.jobId, contactId: s2.contactId, blocks: s2.blocks });
    expect(getEmail(s2.db, emailId)).toMatchObject({ domainMismatch: false, domainUnclear: true });
  });
});

describe("reviewing", () => {
  it("only the user edits, edits show as the text to send, and a sent email cannot be changed", () => {
    const s = setup();
    const { emailId } = s.agent.draftEmail({ jobId: s.jobId, contactId: s.contactId, blocks: s.blocks });
    expect(throws(() => updateEmail(s.db, emailId, { subject: "x", bodyText: "y" }, "agent"))).toMatch(/Only the user/);
    expect(throws(() => s.human.updateEmail(emailId, { subject: "bad\nsubject", bodyText: "text" }))).toMatch(/one line/);
    expect(throws(() => s.human.updateEmail(emailId, { subject: "ok", bodyText: "  " }))).toMatch(/must have text/);
    s.human.updateEmail(emailId, { subject: "My own subject", bodyText: "My own words." });
    expect(getEmail(s.db, emailId)).toMatchObject({ subject: "My own subject", bodyText: "My own words.", edited: true });
    s.human.beginSend(emailId);
    expect(throws(() => s.human.updateEmail(emailId, { subject: "a", bodyText: "b" }))).toMatch(/sending cannot be edited/);
  });

  it("discarding resolves the queue item, returns the job, and allows a new draft", () => {
    const s = setup();
    const { emailId } = s.agent.draftEmail({ jobId: s.jobId, contactId: s.contactId, blocks: s.blocks });
    expect(throws(() => discardEmail(s.db, emailId, "agent"))).toMatch(/Only the user/);
    s.human.discardEmail(emailId);
    expect(getEmail(s.db, emailId)!.status).toBe("discarded");
    expect(listOpenActions(s.db)).toHaveLength(0);
    expect(s.agent.getJob(s.jobId)!.job.state).toBe("materials_ready");
    expect(s.agent.draftEmail({ jobId: s.jobId, contactId: s.contactId, blocks: s.blocks }).emailId).not.toBe(emailId);
  });
});

describe("sending", () => {
  it("a second claim fails, success marks the job applied, and the application is counted", () => {
    const s = setup();
    const { emailId } = s.agent.draftEmail({ jobId: s.jobId, contactId: s.contactId, blocks: s.blocks });
    expect(applicationsToday(s.db)).toBe(0);
    expect(throws(() => beginSend(s.db, emailId, "agent"))).toMatch(/Only the user/);
    s.human.beginSend(emailId);
    expect(throws(() => s.human.beginSend(emailId))).toMatch(/not waiting to be sent/); // a double click
    s.human.finishSend(emailId, "<id-1@example.com>");
    expect(getEmail(s.db, emailId)).toMatchObject({ status: "sent", messageId: "<id-1@example.com>" });
    expect(s.agent.getJob(s.jobId)!.job.state).toBe("applied");
    expect(s.agent.getJob(s.jobId)!.application).toMatchObject({ route: "email" });
    expect(listOpenActions(s.db)).toHaveLength(0);
    expect(applicationsToday(s.db)).toBe(1);
    expect(throws(() => s.human.finishSend(emailId, "x"))).toMatch(/not being sent/);
    expect(throws(() => s.human.discardEmail(emailId))).toMatch(/sent cannot be discarded/);
  });

  it("a failed send can be retried, and keeps the job where it was", () => {
    const s = setup();
    const { emailId } = s.agent.draftEmail({ jobId: s.jobId, contactId: s.contactId, blocks: s.blocks });
    s.human.beginSend(emailId);
    s.human.failSend(emailId, "The mail server refused the login.");
    expect(getEmail(s.db, emailId)).toMatchObject({ status: "failed", error: "The mail server refused the login." });
    expect(s.agent.getJob(s.jobId)!.job.state).toBe("awaiting_approval");
    expect(applicationsToday(s.db)).toBe(0);
    s.human.beginSend(emailId);
    s.human.finishSend(emailId, "<id-2@example.com>");
    expect(getEmail(s.db, emailId)!.status).toBe("sent");
  });

  it("will not send to an address that bounced meanwhile", () => {
    const s = setup();
    const { emailId } = s.agent.draftEmail({ jobId: s.jobId, contactId: s.contactId, blocks: s.blocks });
    s.human.markContactBounced(s.contactId);
    expect(throws(() => s.human.beginSend(emailId))).toMatch(/bounced/);
    expect(getEmail(s.db, emailId)!.status).toBe("draft"); // the claim was rolled back
  });
});
