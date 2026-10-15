import { describe, expect, it } from "vitest";
import {
  ADDRESS_PATTERNS, addFact, createAgentApi, createHumanApi, deriveAddress, derivePatternContact, getEmail, inferPattern, openDb,
  pageShowsName, saveDocument, setPreferences, setProfile, splitName, verifyPerson, type VerifyDeps,
} from "../src/index.js";

const H = "human" as const;
const throws = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as Error).message; } return ""; };

const pages: Record<string, string> = {
  "https://acme.example/team": "<h2>Leadership</h2><p>Jane Doe, Head of Engineering</p><p>José García — CTO</p>",
  "https://acme.example/press": "<p>Press: <a href='mailto:sam.lee@acme.example'>sam.lee@acme.example</a> (Sam Lee)</p>",
};
const deps = (over: Partial<VerifyDeps> = {}): VerifyDeps => ({
  hasMail: async () => true,
  fetchPage: async (u) => { if (!(u in pages)) throw new Error("the page returned 404"); return pages[u]!; },
  ...over,
});

describe("saved posting details", () => {
  const fresh = () => {
    const db = openDb(":memory:");
    return { db, agent: createAgentApi(db) };
  };
  const base = { title: "Backend Engineer", url: "https://a.io/1", canonicalUrl: "https://a.io/1" };

  it("keeps the posting text when a job is added, and returns it only on request", () => {
    const { agent } = fresh();
    const { id } = agent.addCandidateJob({ ...base, description: "  We need a backend engineer who knows Node.js and MySQL.  ", postedBy: "Jane Doe, Head of Engineering", applyUrl: "https://a.io/apply" });
    const job = agent.getJob(id)!.job;
    expect(job).toMatchObject({ hasDescription: true, postedBy: "Jane Doe, Head of Engineering", applyUrl: "https://a.io/apply" });
    expect(JSON.stringify(job)).not.toContain("Node.js"); // the text itself is not in the job row
    expect(agent.getJobDescription(id)).toMatchObject({ description: "We need a backend engineer who knows Node.js and MySQL.", postedBy: "Jane Doe, Head of Engineering" });
    expect(agent.getJobDescription(id)!.detailsAt).toBeTruthy();
    expect(agent.getJobDescription(999)).toBeNull();
  });

  it("caps the length, and a job without text says so", () => {
    const { agent } = fresh();
    const big = agent.addCandidateJob({ ...base, description: "x".repeat(100_000) }).id;
    expect(agent.getJobDescription(big)!.description!.length).toBe(60_000);
    const none = agent.addCandidateJob({ ...base, url: "https://a.io/2", canonicalUrl: "https://a.io/2" }).id;
    expect(agent.getJob(none)!.job.hasDescription).toBe(false);
    expect(agent.getJobDescription(none)!.description).toBeUndefined();
  });

  it("can add the text to a job found earlier, and refuses nonsense", () => {
    const { agent } = fresh();
    const { id } = agent.addCandidateJob(base);
    expect(throws(() => agent.saveJobDetails(id, { description: "too short" }))).toMatch(/too short/);
    expect(throws(() => agent.saveJobDetails(999, { description: "x".repeat(50) }))).toMatch(/not found/);
    agent.saveJobDetails(id, { description: "A real posting text that is long enough to count.", postedBy: "Sam Lee" });
    agent.saveJobDetails(id, { description: "A newer version of the posting text, long enough too." });
    expect(agent.getJobDescription(id)).toMatchObject({ description: "A newer version of the posting text, long enough too.", postedBy: "Sam Lee" });
  });
});

describe("people and company research", () => {
  it("records people once per company, remembers that the company was searched, and checks the inputs", () => {
    const db = openDb(":memory:");
    const agent = createAgentApi(db);
    const co = agent.upsertCompany({ name: "Acme", domain: "acme.example" });
    expect(agent.getCompanyResearch(co)).toMatchObject({ name: "Acme", researchedAt: undefined, people: [], contacts: [] });
    const a = agent.addPerson({ companyId: co, name: "  Jane   Doe ", role: "Head of Engineering", sourceUrl: "https://acme.example/team" });
    const b = agent.addPerson({ companyId: co, name: "Jane Doe", role: "VP Engineering", sourceUrl: "https://acme.example/about" });
    expect(b).toBe(a);
    expect(agent.listPeople(co)).toEqual([{ id: a, companyId: co, name: "Jane Doe", role: "VP Engineering", sourceUrl: "https://acme.example/about" }]);
    expect(throws(() => agent.addPerson({ companyId: co, name: "", role: "CTO", sourceUrl: "https://a.io" }))).toMatch(/name and a role/);
    expect(throws(() => agent.addPerson({ companyId: co, name: "X Y", role: "CTO", sourceUrl: "nope" }))).toMatch(/page they were found on/);
    expect(throws(() => agent.addPerson({ companyId: 999, name: "X Y", role: "CTO", sourceUrl: "https://a.io" }))).toMatch(/not found/);
    agent.markCompanyResearched(co);
    expect(agent.getCompanyResearch(co)!.researchedAt).toBeTruthy();
    expect(throws(() => agent.markCompanyResearched(999))).toMatch(/not found/);
    expect(agent.getCompanyResearch(999)).toBeNull();
  });

  it("a contact can point at a person of its own company only", () => {
    const db = openDb(":memory:");
    const agent = createAgentApi(db);
    const co = agent.upsertCompany({ name: "Acme", domain: "acme.example" });
    const other = agent.upsertCompany({ name: "Other", domain: "other.example" });
    const jane = agent.addPerson({ companyId: co, name: "Jane Doe", role: "CTO", sourceUrl: "https://acme.example/team" });
    const id = agent.addContact({ companyId: co, email: "jane.doe@acme.example", sourceUrl: "https://acme.example/team", personId: jane });
    expect(agent.getCompanyResearch(co)!.contacts[0]).toMatchObject({ id, personId: jane, verification: "on_page" });
    expect(throws(() => agent.addContact({ companyId: other, email: "x@other.example", sourceUrl: "https://other.example", personId: jane }))).toMatch(/does not belong/);
    const mine = createHumanApi(db).addContact({ companyId: co, email: "me@acme.example" });
    expect(createHumanApi(db).getContact(mine)).toMatchObject({ verification: "user", addedBy: "user" });
  });
});

describe("names and address patterns", () => {
  it("splits names and ignores accents, case and extra words", () => {
    expect(splitName("Jane Doe")).toEqual({ first: "jane", last: "doe" });
    expect(splitName("José  García")).toEqual({ first: "jose", last: "garcia" });
    expect(splitName("Mary Ann van der Berg")).toEqual({ first: "mary", last: "berg" });
    expect(splitName("Cher")).toBeNull();
  });

  it("finds which pattern an address follows, and applies it to someone else", () => {
    const cases: [string, string, string, string][] = [
      ["Jane Doe", "jane.doe@acme.example", "first.last", "john.smith@acme.example"],
      ["Jane Doe", "jdoe@acme.example", "flast", "jsmith@acme.example"],
      ["Jane Doe", "janedoe@acme.example", "firstlast", "johnsmith@acme.example"],
      ["Jane Doe", "jane@acme.example", "first", "john@acme.example"],
      ["Jane Doe", "j.doe@acme.example", "f.last", "j.smith@acme.example"],
      ["José García", "jose.garcia@acme.example", "first.last", "john.smith@acme.example"],
    ];
    for (const [name, email, pattern, derived] of cases) {
      expect(inferPattern(name, email), email).toBe(pattern);
      expect(deriveAddress(pattern, "John Smith", "ACME.example"), email).toBe(derived);
    }
    expect(inferPattern("Jane Doe", "careers@acme.example")).toBeUndefined();
    expect(inferPattern("Jane Doe", "jane.doe+hr@acme.example")).toBeUndefined();
    expect(ADDRESS_PATTERNS.map((p) => p.id)).toContain("first.last");
  });

  it("checks that a page really shows a name", () => {
    expect(pageShowsName("<p>Jane   Doe</p>", "jane doe")).toBe(true);
    expect(pageShowsName("<p>José García</p>", "Jose Garcia")).toBe(true);
    expect(pageShowsName("<script>var n='Jane Doe'</script><p>nobody</p>", "Jane Doe")).toBe(false);
    expect(pageShowsName("<p>Jane Doe</p>", "Jane")).toBe(false);
  });
});

describe("verifyPerson", () => {
  it("accepts a name on the page and refuses an invented one or an unreadable page", async () => {
    expect((await verifyPerson({ name: "Jane Doe", sourceUrl: "https://acme.example/team" }, deps())).ok).toBe(true);
    expect((await verifyPerson({ name: "José García", sourceUrl: "https://acme.example/team" }, deps())).ok).toBe(true);
    expect(await verifyPerson({ name: "Eve Invented", sourceUrl: "https://acme.example/team" }, deps())).toMatchObject({ ok: false, reason: expect.stringMatching(/does not appear on/) });
    expect(await verifyPerson({ name: "Jane Doe", sourceUrl: "https://acme.example/gone" }, deps())).toMatchObject({ ok: false, reason: expect.stringMatching(/404/) });
    expect(await verifyPerson({ name: "Madonna", sourceUrl: "https://acme.example/team" }, deps())).toMatchObject({ ok: false });
  });
});

describe("derivePatternContact", () => {
  const input = { personName: "Jane Doe", personUrl: "https://acme.example/team", exampleName: "Sam Lee", exampleEmail: "sam.lee@acme.example", exampleUrl: "https://acme.example/press" };

  it("derives the person's address from a real one at the same company", async () => {
    expect(await derivePatternContact(input, deps())).toEqual({ ok: true, email: "jane.doe@acme.example", pattern: "first.last" });
  });

  it("refuses when any link in the chain is not on a page", async () => {
    const fail = async (over: object, d = deps()) => ((await derivePatternContact({ ...input, ...over }, d)) as any).reason as string;
    expect(await fail({ personName: "Eve Invented" })).toMatch(/Eve Invented does not appear/);
    expect(await fail({ exampleEmail: "nobody@acme.example" })).toMatch(/example address is not usable.*does not appear/);
    expect(await fail({ exampleName: "Eve Invented" })).toMatch(/must be named on the same page/);
    expect(await fail({ exampleName: "Sam Lee", exampleEmail: "press@acme.example" })).toMatch(/example address is not usable/);
    expect(await fail({}, deps({ hasMail: async () => false }))).toMatch(/no mail records/);
  });

  it("refuses an example that follows no pattern", async () => {
    const d = deps({ fetchPage: async (u) => (u.endsWith("press") ? "<p>Press desk: media@acme.example (Sam Lee)</p>" : pages[u]!) });
    expect(((await derivePatternContact({ ...input, exampleEmail: "media@acme.example" }, d)) as any).reason).toMatch(/does not follow a pattern/);
  });
});

describe("a derived address can be drafted at once", () => {
  it("the agent drafts to a pattern contact, and the review shows how it was derived", () => {
    const db = openDb(":memory:");
    setProfile(db, { fullName: "Ada Lovelace", email: "ada@example.com", links: [], languages: [] }, H);
    const agent = createAgentApi(db);
    const co = agent.upsertCompany({ name: "Acme", domain: "acme.example" });
    const { id: jobId } = agent.addCandidateJob({ title: "Backend Engineer", url: "https://acme.example/j", canonicalUrl: "https://acme.example/j", companyId: co });
    const fact = addFact(db, { kind: "experience", text: "Built a payments API serving 50000 users" }, H);
    agent.recordVerification(jobId, { result: "live" }); agent.setMatch(jobId, 8, "fits"); agent.setRoute(jobId, "email");
    saveDocument(db, { jobId, kind: "cv", path: "documents/cv.pdf", blocks: [{ text: "Built a payments API serving 50000 users", factIds: [fact] }] }, "agent");
    agent.transitionJob(jobId, "materials_ready");
    const jane = agent.addPerson({ companyId: co, name: "Jane Doe", role: "Head of Engineering", sourceUrl: "https://acme.example/team" });
    const contactId = agent.addContact({
      companyId: co, email: "jane.doe@acme.example", sourceUrl: "https://acme.example/team", personId: jane, verification: "pattern", name: "Jane Doe", role: "Head of Engineering",
      evidence: { pattern: "first.last", exampleEmail: "sam.lee@acme.example", exampleName: "Sam Lee", exampleUrl: "https://acme.example/press" },
    });
    const { emailId } = agent.draftEmail({ jobId, contactId, blocks: [{ text: "Dear Jane,", factIds: [], kind: "boilerplate" }, { text: "I'm applying for the Backend Engineer role at Acme. I built a payments API serving 50000 users.", factIds: [fact] }, { text: "Best regards,", factIds: [], kind: "boilerplate" }] });
    const e = getEmail(db, emailId)!;
    expect(e.status).toBe("draft");
    expect(e.contact).toMatchObject({ verification: "pattern", evidence: { pattern: "first.last", exampleEmail: "sam.lee@acme.example", exampleUrl: "https://acme.example/press" } });
  });
});

describe("research settings", () => {
  const prefs = { roles: [], seniority: [], locations: [], remotePolicy: "any" as const, industries: [], exclusions: [], dailyApplicationLimit: 5, dailyDiscoveryLimit: 5, searchAnySite: true };
  it("have defaults, round-trip, and are validated", () => {
    const db = openDb(":memory:");
    setPreferences(db, prefs, H);
    expect(createAgentApi(db).getPreferences()).toMatchObject({ researchMinScore: 7, researchScope: "all", batchSize: 10 });
    setPreferences(db, { ...prefs, researchMinScore: 9, researchScope: "email_only", batchSize: 4 }, H);
    expect(createAgentApi(db).getPreferences()).toMatchObject({ researchMinScore: 9, researchScope: "email_only", batchSize: 4 });
    expect(throws(() => setPreferences(db, { ...prefs, researchMinScore: 11 }, H))).toMatch(/0 to 10/);
    expect(throws(() => setPreferences(db, { ...prefs, researchScope: "sometimes" as never }, H))).toMatch(/all, email_only or off/);
    expect(throws(() => setPreferences(db, { ...prefs, batchSize: 0 }, H))).toMatch(/1 to 20/);
    expect(throws(() => setPreferences(db, { ...prefs, batchSize: 21 }, H))).toMatch(/1 to 20/);
  });
});
