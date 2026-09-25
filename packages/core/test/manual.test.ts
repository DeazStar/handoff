import { describe, expect, it } from "vitest";
import {
  addFact, applicationsToday, createAgentApi, discoveryBudget, dueFollowUps, getSyncTargets, ingestMessages, listMessages, listTracker, openDb,
  recordManualApplication, saveDocument, scanFollowUps, setPreferences, setProfile, type DB, type ManualApplication,
} from "../src/index.js";

const H = "human" as const;
const throws = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as Error).message; } return ""; };
const prefs = (over: object = {}) => ({ roles: [], seniority: [], locations: [], remotePolicy: "any" as const, industries: [], exclusions: [], dailyApplicationLimit: 5, dailyDiscoveryLimit: 3, searchAnySite: true, ...over });
const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toLocaleDateString("sv-SE");
const entry = (over: Partial<ManualApplication> = {}): ManualApplication => ({ title: "Backend Engineer", company: "Acme", appliedOn: day(5), how: "form", ...over });
const stateOf = (db: DB, id: number) => (db.prepare("SELECT state FROM jobs WHERE id = ?").get(id) as { state: string }).state;

function setup() {
  const db = openDb(":memory:");
  setProfile(db, { fullName: "Ada Lovelace", email: "ada@gmail.com", links: [], languages: [] }, H);
  setPreferences(db, prefs(), H);
  return db;
}

describe("recordManualApplication", () => {
  it("makes an applied job with its date, route and notes", () => {
    const db = setup();
    const { jobId } = recordManualApplication(db, entry({ url: "https://acme.example/jobs/1?utm_source=x", notes: "Referred by Sam" }), H);
    expect(stateOf(db, jobId)).toBe("applied");
    const [row] = listTracker(db);
    expect(row).toMatchObject({ jobId, title: "Backend Engineer", company: "Acme", state: "applied", route: "form", manual: true, notes: "Referred by Sam", url: "https://acme.example/jobs/1?utm_source=x", daysSince: 5 });
    expect(row!.appliedAt.slice(0, 10)).toBe(day(5));
    expect(row!.allowed).toEqual(expect.arrayContaining(["replied", "rejected", "no_response"]));
  });

  it("starts in the state the user says, one allowed step at a time", () => {
    const db = setup();
    const ids = (["replied", "interview", "offer", "rejected", "no_response"] as const).map((status, i) => ({ status, id: recordManualApplication(db, entry({ title: `Job ${i}`, status }), H).jobId }));
    for (const { status, id } of ids) expect(stateOf(db, id)).toBe(status);
    const history = (id: number) => (db.prepare("SELECT detail FROM events WHERE job_id = ? AND type = 'state_changed' ORDER BY id").all(id) as { detail: string }[]).map((e) => JSON.parse(e.detail).to);
    expect(history(ids.find((x) => x.status === "offer")!.id)).toEqual(["verified_live", "matched", "materials_ready", "awaiting_approval", "applied", "replied", "interview", "offer"]);
  });

  it("works without a link, and refuses the same job twice", () => {
    const db = setup();
    const a = recordManualApplication(db, entry(), H);
    expect(listTracker(db)[0]!.url).toBeUndefined();
    expect(throws(() => recordManualApplication(db, entry({ title: "backend engineer" }), H))).toMatch(new RegExp(`already track this one \\(job ${a.jobId}`));
    recordManualApplication(db, entry({ url: "https://acme.example/jobs/9" }), H);
    expect(throws(() => recordManualApplication(db, entry({ title: "Other", url: "https://acme.example/jobs/9?utm_campaign=y" }), H))).toMatch(/already track this one/);
    // the same title at another company is a different job
    expect(() => recordManualApplication(db, entry({ company: "Other Co" }), H)).not.toThrow();
  });

  it("reuses a company by name, and one job the tool found but you applied for by hand", () => {
    const db = setup();
    const agent = createAgentApi(db);
    const co = agent.upsertCompany({ name: "Acme", domain: "acme.example" });
    const found = agent.addCandidateJob({ title: "Backend Engineer", url: "https://acme.example/jobs/5", canonicalUrl: "https://acme.example/jobs/5", companyId: co }).id;
    const r = recordManualApplication(db, entry({ url: "https://acme.example/jobs/5" }), H);
    expect(r.jobId).toBe(found);
    expect(stateOf(db, found)).toBe("applied");
    expect(db.prepare("SELECT COUNT(*) AS n FROM companies WHERE lower(name) = 'acme'").get()).toEqual({ n: 1 });
  });

  it("refuses to record over a job that has a draft or a prepared form waiting", () => {
    const db = setup();
    const agent = createAgentApi(db);
    const co = agent.upsertCompany({ name: "Acme", domain: "acme.example" });
    const id = agent.addCandidateJob({ title: "Backend Engineer", url: "https://acme.example/jobs/6", canonicalUrl: "https://acme.example/jobs/6", companyId: co }).id;
    agent.recordVerification(id, { result: "live" }); agent.setMatch(id, 7, "fits"); agent.setRoute(id, "form");
    const fact = addFact(db, { kind: "experience", text: "Built a payments API serving 50000 users" }, H);
    saveDocument(db, { jobId: id, kind: "cv", path: "documents/cv.pdf", blocks: [{ text: "Built a payments API serving 50000 users", factIds: [fact] }] }, "agent");
    agent.transitionJob(id, "materials_ready");
    agent.prepareApplication({ jobId: id, formUrl: "https://acme.example/apply", answers: [{ question: "Q", answer: "A", kind: "policy" }], leftBlank: [] });
    expect(throws(() => recordManualApplication(db, entry({ url: "https://acme.example/jobs/6" }), H))).toMatch(/prepared form or an email draft/);
  });

  it("checks what it is given, and only a person can record", () => {
    const db = setup();
    const bad = (o: Partial<ManualApplication>) => throws(() => recordManualApplication(db, entry(o), H));
    expect(bad({ title: " " })).toMatch(/title/);
    expect(bad({ company: "" })).toMatch(/company/);
    expect(bad({ appliedOn: "yesterday" })).toMatch(/date/);
    expect(bad({ appliedOn: "2999-01-01" })).toMatch(/future/);
    expect(bad({ how: "carrier pigeon" as never })).toMatch(/how you applied/);
    expect(bad({ status: "hired" as never })).toMatch(/Unknown status/);
    expect(bad({ url: "ftp://x.y/z" })).toMatch(/web link/);
    expect(bad({ contactEmail: "nope" })).toMatch(/valid email/);
    expect(throws(() => recordManualApplication(db, entry(), "agent"))).toMatch(/Only the user/);
  });
});

describe("limits and reminders", () => {
  it("uses neither the discovery limit nor today's application count for a past date", () => {
    const db = setup();
    recordManualApplication(db, entry({ appliedOn: day(3) }), H);
    recordManualApplication(db, entry({ title: "Second", appliedOn: day(1) }), H);
    expect(discoveryBudget(db)).toEqual({ limit: 3, addedToday: 0, remaining: 3 });
    expect(applicationsToday(db)).toBe(0);
    recordManualApplication(db, entry({ title: "Today", appliedOn: day(0) }), H);
    expect(applicationsToday(db)).toBe(1);
    expect(discoveryBudget(db).addedToday).toBe(0);
  });

  it("reminds about an old one, and marks a very old one as no response, like any other application", () => {
    const db = setup();
    const old = recordManualApplication(db, entry({ title: "Old", appliedOn: day(9) }), H).jobId;
    const veryOld = recordManualApplication(db, entry({ title: "Very old", appliedOn: day(40) }), H).jobId;
    recordManualApplication(db, entry({ title: "New", appliedOn: day(1) }), H);
    expect(dueFollowUps(db).map((d) => d.jobId).sort()).toEqual([old, veryOld].sort());
    const r = scanFollowUps(db, "system");
    expect(r.markedNoResponse).toBe(1);
    expect(stateOf(db, veryOld)).toBe("no_response");
    expect(stateOf(db, old)).toBe("applied");
  });

  it("gives a by-hand email application a reminder to check, not a thread to follow up in", () => {
    const db = setup();
    const id = recordManualApplication(db, entry({ how: "email", contactEmail: "jane@acme.example", appliedOn: day(9) }), H).jobId;
    expect(dueFollowUps(db)).toEqual([expect.objectContaining({ jobId: id, route: "manual" })]);
    expect(scanFollowUps(db).queued).toBe(1);
    const q = db.prepare("SELECT payload FROM action_queue WHERE kind = 'follow_up' AND job_id = ?").get(id) as { payload: string };
    expect(JSON.parse(q.payload)).toMatchObject({ reason: "portal", byHand: true });
  });
});

describe("replies to an application made by hand", () => {
  it("matches mail from the address you wrote to, as a suggestion, and asks the mailbox for it", () => {
    const db = setup();
    const id = recordManualApplication(db, entry({ how: "email", contactEmail: "jane@acme.example", contactName: "Jane Doe" }), H).jobId;
    expect(getSyncTargets(db)).toMatchObject({ messageIds: [], senders: ["acme.example"] });
    const r = ingestMessages(db, [
      { messageId: "<r1@acme.example>", fromAddr: "jane@acme.example", subject: "Your application", receivedAt: new Date().toISOString(), snippet: "Could we schedule a call? What is your availability?" },
      { messageId: "<x@else.example>", fromAddr: "news@else.example", subject: "Hi", receivedAt: new Date().toISOString(), snippet: "" },
    ], H);
    expect(r).toMatchObject({ matched: 1, replies: 1, movedToReplied: 0 });
    const m = listMessages(db)[0]!;
    expect(m).toMatchObject({ jobId: id, matchedBy: "sender", category: "interview" });
    expect((db.prepare("SELECT email_id FROM messages WHERE id = ?").get(m.id) as { email_id: number | null }).email_id).toBeNull();
    expect(stateOf(db, id)).toBe("applied"); // a sender match never moves the job by itself
  });

  it("looks for a free-mail contact by its exact address", () => {
    const db = setup();
    recordManualApplication(db, entry({ how: "email", contactEmail: "recruiter@gmail.com" }), H);
    expect(getSyncTargets(db).senders).toEqual(["recruiter@gmail.com"]);
  });
});
