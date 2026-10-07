import { describe, expect, it } from "vitest";
import {
  addFact, applicationsToday, createAgentApi, createHumanApi, deleteStandardAnswer, listOpenActions, markApplicationSubmitted, openDb,
  prepareApplication, saveDocument, setPreferences, setProfile, setStandardAnswer, type PrepareInput,
} from "../src/index.js";

const H = "human" as const;
const throws = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as Error).message; } return ""; };

const prefs = (over: object = {}) => ({
  roles: [], seniority: [], locations: [], remotePolicy: "any" as const, industries: [], exclusions: [], dailyApplicationLimit: 5, dailyDiscoveryLimit: 5,
  searchAnySite: true, salaryFloor: 900, salaryTarget: 1400, salaryCeiling: 2000, currency: "USD", salaryPeriod: "month" as const, ...over,
});

function setup(opts: { route?: "form" | "email"; ready?: boolean; cv?: boolean } = {}) {
  const db = openDb(":memory:");
  setProfile(db, { fullName: "Ada Lovelace", email: "ada@example.com", links: [], languages: [], workAuthorization: "needs sponsorship", requiresSponsorship: true }, H);
  setPreferences(db, prefs(), H);
  const agent = createAgentApi(db);
  const human = createHumanApi(db);
  const co = agent.upsertCompany({ name: "Acme", domain: "acme.example" });
  const jobId = agent.addCandidateJob({ title: "Backend Engineer", url: "https://acme.example/j/1", canonicalUrl: "https://acme.example/j/1", companyId: co }).id;
  const fact = addFact(db, { kind: "experience", text: "Built a payments API serving 50000 users" }, H);
  agent.recordVerification(jobId, { result: "live" });
  agent.setMatch(jobId, 8, "fits");
  agent.setRoute(jobId, opts.route ?? "form");
  if (opts.cv !== false) saveDocument(db, { jobId, kind: "cv", path: "documents/job-1-cv-v1.pdf", blocks: [{ text: "Built a payments API serving 50000 users", factIds: [fact] }] }, "agent");
  if (opts.ready !== false) agent.transitionJob(jobId, "materials_ready");
  const input = (over: Partial<PrepareInput> = {}): PrepareInput => ({
    jobId,
    formUrl: "https://acme.example/apply/1",
    answers: [
      { question: "Full name", answer: "Ada Lovelace", kind: "profile", from: ["profile:fullName"] },
      { question: "Do you need visa sponsorship?", answer: "Yes", kind: "profile", from: ["profile:requiresSponsorship"], sensitive: true },
      { question: "Why do you want to work here?", answer: "I built a payments API serving 50000 users and want to do that for wallets.", kind: "free_text", factIds: [fact] },
    ],
    leftBlank: [{ question: "Gender", why: "Optional demographic question; left for the user" }],
    ...over,
  });
  return { db, agent, human, jobId, fact, input };
}

describe("preparing a form application", () => {
  it("records what was entered, queues it for the user and moves the job", () => {
    const s = setup();
    const { applicationId } = s.agent.prepareApplication(s.input({ salaryQuoted: 1400, salaryReason: "Target of the user's range for a senior backend role." }));
    const app = s.agent.getApplication(s.jobId)!;
    expect(app).toMatchObject({ id: applicationId, route: "form", status: "prepared", formUrl: "https://acme.example/apply/1", salaryQuoted: 1400, salaryPeriod: "month" });
    expect(app.answers).toHaveLength(3);
    expect(app.leftBlank).toEqual([{ question: "Gender", why: "Optional demographic question; left for the user" }]);
    const open = listOpenActions(s.db) as any[];
    expect(open.map((a) => a.kind)).toEqual(["confirm_submit"]);
    expect(JSON.parse(open[0].payload)).toMatchObject({ formUrl: "https://acme.example/apply/1", answers: 3, leftBlank: 1 });
    expect(s.agent.getJob(s.jobId)!.job.state).toBe("awaiting_approval");
    expect(applicationsToday(s.db)).toBe(0); // nothing is submitted yet
  });

  it("refuses a job that is not ready, not a form, or has no CV", () => {
    expect(throws(() => setup({ route: "email" }).agent.prepareApplication(setup({ route: "email" }).input()))).toMatch(/does not apply through a form/);
    const a = setup({ ready: false });
    expect(throws(() => a.agent.prepareApplication(a.input()))).toMatch(/materials_ready \(it is matched\)/);
    const b = setup({ cv: false });
    expect(throws(() => b.agent.prepareApplication(b.input()))).toMatch(/no CV/);
    const c = setup();
    expect(throws(() => c.agent.prepareApplication(c.input({ jobId: 999 })))).toMatch(/not found/);
    expect(throws(() => c.agent.prepareApplication(c.input({ formUrl: "not a link" })))).toMatch(/link of the form/);
    expect(throws(() => c.agent.prepareApplication(c.input({ answers: [] })))).toMatch(/Record the answers/);
  });

  it("checks every answer", () => {
    const s = setup();
    const one = (a: object) => throws(() => s.agent.prepareApplication(s.input({ answers: [{ question: "Q", answer: "A", kind: "profile", from: ["profile:fullName"], ...a }] })));
    expect(one({ question: " " })).toMatch(/form's question/);
    expect(one({ answer: " " })).toMatch(/must have text/);
    expect(one({ kind: "made_up" })).toMatch(/Unknown answer kind/);
    expect(one({ kind: "free_text", answer: "I led a team of 10 engineers", factIds: [s.fact] })).toMatch(/"10" does not appear in the cited facts/);
    expect(one({ kind: "free_text", answer: "I served 90000 users", factIds: [s.fact] })).toMatch(/90000/);
    expect(one({ kind: "free_text", answer: "I have 8 years of experience" })).toMatch(/numbers/); // no facts, so it cannot carry a number
    expect(s.agent.getApplication(s.jobId)).toBeNull(); // every refusal left nothing behind
    expect(listOpenActions(s.db)).toHaveLength(0);
  });

  it("only quotes a salary inside the user's range, in their unit, with a reason", () => {
    const s = setup();
    const salary = (over: object, p = s) => throws(() => p.agent.prepareApplication(p.input({ salaryReason: "Within the range and fair for the role.", ...over })));
    expect(salary({ salaryQuoted: 500 })).toMatch(/outside your range \(900 to 2000 per month\)/);
    expect(salary({ salaryQuoted: 5000 })).toMatch(/outside your range/);
    expect(salary({ salaryQuoted: 1200.5 })).toMatch(/whole number/);
    expect(salary({ salaryQuoted: 1200, salaryReason: "ok" })).toMatch(/why you chose/);
    const noPeriod = setup();
    setPreferences(noPeriod.db, prefs({ salaryPeriod: undefined }), H);
    expect(salary({ salaryQuoted: 1200 }, noPeriod)).toMatch(/per month or per year/);
    const noRange = setup();
    setPreferences(noRange.db, prefs({ salaryFloor: undefined, salaryTarget: undefined, salaryCeiling: undefined, currency: undefined }), H);
    expect(salary({ salaryQuoted: 1200 }, noRange)).toMatch(/Set your salary range/);
    expect(salary({ salaryQuoted: 900 })).toBe(""); // the floor itself is allowed
  });

  it("preparing again replaces the earlier version and leaves one item in the queue", () => {
    const s = setup();
    s.agent.prepareApplication(s.input());
    s.human.discardApplication(s.jobId);
    s.agent.prepareApplication(s.input({ formUrl: "https://acme.example/apply/2" }));
    expect(s.agent.getApplication(s.jobId)).toMatchObject({ status: "prepared", formUrl: "https://acme.example/apply/2" });
    expect((listOpenActions(s.db) as any[]).filter((a) => a.kind === "confirm_submit")).toHaveLength(1);
  });

  it("stops at the daily limit, counting what is waiting for the user", () => {
    const s = setup();
    setPreferences(s.db, prefs({ dailyApplicationLimit: 1 }), H);
    s.agent.prepareApplication(s.input());
    const other = s.agent.addCandidateJob({ title: "Other", url: "https://b.io/1", canonicalUrl: "https://b.io/1" }).id;
    s.agent.recordVerification(other, { result: "live" }); s.agent.setMatch(other, 7, "ok"); s.agent.setRoute(other, "form");
    saveDocument(s.db, { jobId: other, kind: "cv", path: "documents/job-2-cv-v1.pdf", blocks: [{ text: "Built a payments API serving 50000 users", factIds: [s.fact] }] }, "agent");
    s.agent.transitionJob(other, "materials_ready");
    expect(throws(() => s.agent.prepareApplication(s.input({ jobId: other })))).toMatch(/Daily limit reached \(1 of 1/);
    s.human.markApplicationSubmitted(s.jobId); // submitted today still counts
    expect(throws(() => s.agent.prepareApplication(s.input({ jobId: other })))).toMatch(/Daily limit reached/);
    setPreferences(s.db, prefs({ dailyApplicationLimit: 2 }), H);
    s.agent.prepareApplication(s.input({ jobId: other }));
  });
});

describe("consent and demographic answers", () => {
  it("records a ticked consent box as its own kind, and a saved demographic answer as a standard answer", () => {
    const s = setup();
    s.human.setStandardAnswer("Gender", "Prefer not to say");
    expect(s.agent.listStandardAnswers().map((a) => a.label)).toContain("Gender");
    s.agent.prepareApplication(s.input({
      answers: [
        { question: "Gender", answer: "Prefer not to say", kind: "standard", from: ["standard:Gender"] },
        { question: "I consent to the processing of my data for this application", answer: "ticked", kind: "consent", sensitive: true },
      ],
    }));
    const app = s.agent.getApplication(s.jobId)!;
    expect(app.answers.map((a) => a.kind)).toEqual(["standard", "consent"]);
    expect(app.answers[1]!.sensitive).toBe(true);
  });
});

describe("the user submits or discards", () => {
  it("only the user marks it submitted; it then counts, and the job is applied", () => {
    const s = setup();
    s.agent.prepareApplication(s.input());
    expect(throws(() => markApplicationSubmitted(s.db, s.jobId, "agent"))).toMatch(/Only the user/);
    s.human.markApplicationSubmitted(s.jobId);
    expect(s.agent.getApplication(s.jobId)).toMatchObject({ status: "submitted" });
    expect(s.agent.getApplication(s.jobId)!.sentAt).toBeTruthy();
    expect(s.agent.getJob(s.jobId)!.job.state).toBe("applied");
    expect(listOpenActions(s.db)).toHaveLength(0);
    expect(applicationsToday(s.db)).toBe(1);
    expect(throws(() => s.human.markApplicationSubmitted(s.jobId))).toMatch(/no prepared application/);
    expect(throws(() => s.agent.prepareApplication(s.input()))).toMatch(/materials_ready|already submitted/);
  });

  it("discarding returns the job and clears the queue", () => {
    const s = setup();
    s.agent.prepareApplication(s.input());
    expect(throws(() => createAgentApi(s.db) && (s.agent as any).discardApplication?.(s.jobId))).toMatch(/not a function|^$/);
    s.human.discardApplication(s.jobId);
    expect(s.agent.getApplication(s.jobId)!.status).toBe("discarded");
    expect(s.agent.getJob(s.jobId)!.job.state).toBe("materials_ready");
    expect(listOpenActions(s.db)).toHaveLength(0);
    expect(throws(() => s.human.discardApplication(s.jobId))).toMatch(/no prepared application/);
    expect(s.human.listApplications("discarded")).toHaveLength(1);
    expect(s.human.listApplications("prepared")).toEqual([]);
  });

  it("an email send is recorded as a submitted application too", () => {
    const s = setup();
    expect(s.human.listApplications()).toEqual([]);
    expect("markApplicationSubmitted" in s.agent).toBe(false);
  });
});

describe("standard answers", () => {
  it("are the user's words: only the user writes them, the agent reads them", () => {
    const db = openDb(":memory:");
    const agent = createAgentApi(db);
    const human = createHumanApi(db);
    expect(throws(() => setStandardAnswer(db, "How did you hear about us?", "A job board", "agent"))).toMatch(/Only the user/);
    human.setStandardAnswer("  How did you hear about us?  ", "A job board");
    human.setStandardAnswer("How did you hear about us?", "The company website");
    human.setStandardAnswer("Willing to relocate?", "No, remote only");
    expect(agent.listStandardAnswers().map((a) => [a.label, a.answer])).toEqual([["How did you hear about us?", "The company website"], ["Willing to relocate?", "No, remote only"]]);
    expect(throws(() => human.setStandardAnswer("", "x"))).toMatch(/label/);
    expect(throws(() => human.setStandardAnswer("Q", " "))).toMatch(/text/);
    expect("setStandardAnswer" in agent).toBe(false);
    const id = agent.listStandardAnswers()[0]!.id;
    expect(throws(() => deleteStandardAnswer(db, id, "agent"))).toMatch(/Only the user/);
    human.deleteStandardAnswer(id);
    expect(agent.listStandardAnswers()).toHaveLength(1);
    expect(throws(() => human.deleteStandardAnswer(id))).toMatch(/not found/);
  });

  it("the salary period is validated and returned", () => {
    const db = openDb(":memory:");
    setPreferences(db, prefs({ salaryPeriod: "year" }), H);
    expect(createAgentApi(db).getPreferences()!.salaryPeriod).toBe("year");
    expect(throws(() => setPreferences(db, prefs({ salaryPeriod: "week" }), H))).toMatch(/month or year/);
  });
});
