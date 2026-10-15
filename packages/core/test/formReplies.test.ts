import { describe, expect, it } from "vitest";
import { addFact, createAgentApi, createHumanApi, getSyncTargets, ingestMessages, listMessages, openDb, saveDocument, setPreferences, setProfile, type InboundMessage } from "../src/index.js";

const H = "human" as const;
const later = () => new Date(Date.now() + 3600_000).toISOString();
const msg = (over: Partial<InboundMessage>): InboundMessage => ({ messageId: `<${Math.random().toString(36).slice(2)}@x>`, fromAddr: "someone@example.org", subject: "Hello", receivedAt: later(), snippet: "", ...over });

/** A job applied for through a form: no email of ours exists. */
function setup(jobs: { title: string; company?: string; domain?: string }[] = [{ title: "Backend Engineer" }]) {
  const db = openDb(":memory:");
  setProfile(db, { fullName: "Ada Lovelace", email: "ada@example.com", links: [], languages: [] }, H);
  setPreferences(db, { roles: [], seniority: [], locations: [], remotePolicy: "any", industries: [], exclusions: [], dailyApplicationLimit: 20, dailyDiscoveryLimit: 5, searchAnySite: true, salaryFloor: 900, salaryTarget: 1400, salaryCeiling: 2000, currency: "USD", salaryPeriod: "month" }, H);
  const agent = createAgentApi(db);
  const human = createHumanApi(db);
  const fact = addFact(db, { kind: "experience", text: "Built a payments API serving 50000 users" }, H);
  const ids = jobs.map((j, i) => {
    const co = agent.upsertCompany({ name: j.company ?? "Acme", domain: j.domain ?? "acme.example" });
    const id = agent.addCandidateJob({ title: j.title, url: `https://acme.example/j/${i}`, canonicalUrl: `https://acme.example/j/${i}`, companyId: co }).id;
    agent.recordVerification(id, { result: "live" });
    agent.setMatch(id, 8, "fits");
    agent.setRoute(id, "form");
    saveDocument(db, { jobId: id, kind: "cv", path: `documents/cv-${i}.pdf`, blocks: [{ text: "Built a payments API serving 50000 users", factIds: [fact] }] }, "agent");
    agent.transitionJob(id, "materials_ready");
    agent.prepareApplication({ jobId: id, formUrl: `https://acme.example/apply/${i}`, answers: [{ question: "Full name", answer: "Ada Lovelace", kind: "profile", from: ["profile:fullName"] }], leftBlank: [] });
    human.markApplicationSubmitted(id);
    return id;
  });
  return { db, agent, human, ids };
}
const state = (db: ReturnType<typeof openDb>, id: number) => (db.prepare("SELECT state FROM jobs WHERE id = ?").get(id) as { state: string }).state;

describe("replies to jobs applied for through a form", () => {
  it("keeps mail from the company's own address as a possible match, and never moves the job by itself", () => {
    const { db, ids } = setup();
    const r = ingestMessages(db, [msg({ fromAddr: "recruiting@acme.example", subject: "Your application", snippet: "Thanks for applying" })], "system");
    expect(r).toMatchObject({ matched: 1, replies: 1, movedToReplied: 0 });
    const m = listMessages(db)[0]!;
    expect(m).toMatchObject({ jobId: ids[0], matchedBy: "domain", status: "new" });
    expect(state(db, ids[0]!)).toBe("applied");
  });

  it("matches a job platform's mail only when it names the company and the job title, and arrived after applying", () => {
    const { db, ids } = setup();
    const platform = (over: Partial<InboundMessage>) => msg({ fromAddr: "no-reply@greenhouse-mail.io", ...over });
    const r = ingestMessages(db, [
      platform({ subject: "Thank you for applying to Acme", snippet: "We received your application for Backend Engineer." }),
      platform({ subject: "Thank you for applying", snippet: "We received your application for Backend Engineer." }), // no company
      platform({ subject: "Thank you for applying to Acme", snippet: "We received your application for Designer." }), // another title
      platform({ subject: "Thank you for applying to Acme", snippet: "Backend Engineer", receivedAt: new Date(Date.now() - 86_400_000).toISOString() }), // before applying
      msg({ fromAddr: "news@newsletter.example", subject: "Acme Backend Engineer jobs", snippet: "Backend Engineer at Acme" }), // not a platform
      msg({ fromAddr: "friend@gmail.com", subject: "Acme", snippet: "Backend Engineer at Acme" }), // free mail
    ], "system");
    expect(r.matched).toBe(1);
    expect(listMessages(db)[0]).toMatchObject({ jobId: ids[0], matchedBy: "platform" });
  });

  it("picks the job whose title the mail names when a company has two", () => {
    const { db, ids } = setup([{ title: "Backend Engineer" }, { title: "Data Scientist" }]);
    ingestMessages(db, [msg({ fromAddr: "jobs@lever.co", subject: "Acme: your application", snippet: "Thanks for applying for Data Scientist at Acme" })], "system");
    expect(listMessages(db)[0]).toMatchObject({ jobId: ids[1], matchedBy: "platform" });
  });

  it("ignores jobs that are not live, jobs not yet submitted, and keeps an unrelated message out", () => {
    const { db, ids, human } = setup();
    human.transitionJob(ids[0]!, "replied");
    human.transitionJob(ids[0]!, "rejected");
    expect(ingestMessages(db, [msg({ fromAddr: "recruiting@acme.example", subject: "Hello" })], "system").matched).toBe(0);
    const other = setup();
    expect(ingestMessages(other.db, [msg({ fromAddr: "hello@unrelated.example", subject: "Hello" })], "system").matched).toBe(0);
    expect(listMessages(other.db)).toEqual([]);
  });

  it("is never stored twice, and the user can mark it as not about this job", () => {
    const { db, human } = setup();
    const m = msg({ fromAddr: "recruiting@acme.example", subject: "Your application" });
    ingestMessages(db, [m], "system");
    expect(ingestMessages(db, [m], "system").matched).toBe(0);
    human.setMessageStatus(listMessages(db)[0]!.id, "ignored");
    expect(listMessages(db)[0]).toMatchObject({ status: "ignored" });
  });

  it("asks the mailbox for the company's address and name, only while the job is live", () => {
    const { db, ids, human } = setup();
    expect(getSyncTargets(db)).toMatchObject({ senders: expect.arrayContaining(["acme.example"]), companyTerms: ["Acme"] });
    human.transitionJob(ids[0]!, "replied");
    human.transitionJob(ids[0]!, "rejected");
    expect(getSyncTargets(db).companyTerms).toEqual([]);
  });
});
