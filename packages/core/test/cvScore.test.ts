import { describe, expect, it } from "vitest";
import { repeatsBullet, addBullet, addEntry, createAgentApi, createHumanApi, getCvScore, headlineProblems, openDb, prepareCv, saveDocument, setProfile, setSkillGroup, summaryProblems } from "../src/index.js";

const H = "human" as const;
const throws = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as Error).message; } return ""; };

const setup = () => {
  const db = openDb(":memory:");
  setProfile(db, { fullName: "Ada Lovelace", email: "ada@example.com", phone: "+1 555 0100", links: [], languages: [] }, H);
  const acme = addEntry(db, { kind: "work", title: "Lead Backend Engineer", organization: "Acme", startDate: "2022-03", isCurrent: true }, H);
  const p1 = addEntry(db, { kind: "project", title: "Booking site" }, H);
  const p2 = addEntry(db, { kind: "project", title: "Sign language model" }, H);
  const a1 = addBullet(db, acme, "Built a payments API serving 50000 users with Node.js and PostgreSQL", H);
  const a2 = addBullet(db, acme, "Cut query time by 40%", H);
  const b1 = addBullet(db, p1, "Booking platform with React", H);
  addBullet(db, p2, "LSTM model recognizing 100 signs", H);
  setSkillGroup(db, "Backend", ["Node.js", "TypeScript"], H);
  const skill = (t: string) => (db.prepare("SELECT id FROM facts WHERE text = ?").get(t) as { id: number }).id;
  const job = createAgentApi(db).addCandidateJob({ title: "Backend Engineer", url: "https://a.io/1", canonicalUrl: "https://a.io/1" }).id;
  return { db, acme, p1, p2, a1, a2, b1, skill, job };
};

describe("the CV summary rules", () => {
  it("refuses first person, long sentences and filler, and a years claim above what the roles add up to", () => {
    const r = summaryProblems(["I lead backend work on a platform.", "Backend engineer who is passionate about robust systems.", "Engineer with 20+ years of experience."], 4);
    const text = r.problems.join(" | ");
    expect(text).toMatch(/no first person \("I"\)/);
    expect(text).toMatch(/"passionate" is filler/);
    expect(text).toMatch(/"20\+ years" is more than the 4 full years/);
    expect(summaryProblems([Array(35).fill("word").join(" ")], 4).problems.join(" ")).toMatch(/35 words/);
  });

  it("refuses numbers other than years, and a sentence that repeats a bullet", () => {
    const r = summaryProblems(["Backend engineer who cut query time by 40% on a platform."], 4);
    expect(r.problems.join(" ")).toMatch(/no numbers except years/);
    expect(repeatsBullet("Rebuilt the generated queries behind a reporting platform around SQL window functions", ["Rebuilt the generated queries around SQL window functions, removing the Cartesian join on the reporting platform"])).toBeTruthy();
    expect(repeatsBullet("Leads backend work on a payments platform and has built e-commerce platforms", ["Built a full-stack e-commerce platform using TypeScript and Node.js", "Designed REST APIs and authentication for payment data"])).toBeUndefined();
  });

  it("allows a years claim the roles back, and cannot check one without dates", () => {
    expect(summaryProblems(["Backend engineer with 3+ years building Node.js services."], 4)).toEqual({ problems: [], allow: [["3"]] });
    expect(summaryProblems(["Engineer with 3 years of experience."], undefined).problems[0]).toMatch(/cannot be checked/);
  });
});

describe("the headline", () => {
  it("is a short label: no digits, no first person, no seniority your titles do not carry", () => {
    expect(headlineProblems("Backend-leaning Full-Stack Engineer", ["Software Engineer"])).toEqual([]);
    expect(headlineProblems("Senior Backend Engineer", ["Software Engineer"]).join(" ")).toMatch(/"Senior"/);
    expect(headlineProblems("Lead Backend Engineer", ["Lead Backend Engineer"])).toEqual([]);
    expect(headlineProblems("5 years of Node.js", []).join(" ")).toMatch(/digits/);
    expect(headlineProblems("My engineering career", []).join(" ")).toMatch(/first person/);
  });
});

describe("saving a CV with the new summary", () => {
  it("accepts a server-derived years figure and renders the headline in the plan", () => {
    const { db, acme, a1, a2, skill, job } = setup();
    const plan = {
      headline: "Backend-leaning Full-Stack Engineer",
      summary: [{ text: "Backend engineer with 1+ years building Node.js services.", factIds: [skill("Node.js")] }, { text: "Currently leads backend work on a payments platform.", factIds: [a1] }],
      experience: [{ entryId: acme, bullets: [a1, a2] }],
    };
    const { cv, blocks } = prepareCv(db, plan, null);
    expect(cv.header.headline).toBe("Backend-leaning Full-Stack Engineer");
    expect(() => saveDocument(db, { jobId: null, kind: "cv", path: "documents/x.pdf", blocks, plan }, H)).not.toThrow();
    const bad = { ...plan, summary: [{ text: "Backend engineer with 9+ years building Node.js services.", factIds: [skill("Node.js")] }] };
    expect(throws(() => prepareCv(db, bad, null))).toMatch(/"9\+ years" is more than/);
  });
});

describe("scoring a CV against the posting", () => {
  it("scores the four parts, finds keywords by section, and lists what to fix", () => {
    const { db, acme, p1, a1, a2, b1, skill, job } = setup();
    const agent = createAgentApi(db);
    const plan = {
      headline: "Backend-leaning Full-Stack Engineer",
      summary: [{ text: "Backend engineer with 1+ years building Node.js services.", factIds: [skill("Node.js")] }],
      experience: [{ entryId: acme, bullets: [a1, a2] }],
      projects: [{ entryId: p1, bullets: [b1] }],
      skills: [{ group: "Backend", factIds: [skill("Node.js"), skill("TypeScript")] }],
    };
    const { blocks } = prepareCv(db, plan, job);
    const doc = saveDocument(db, { jobId: job, kind: "cv", path: "documents/x.pdf", blocks, plan }, "agent");
    const s = agent.scoreCv(doc.id, [{ term: "Node.js", critical: true }, { term: "PostgreSQL", critical: true }, { term: "AWS", critical: true }, { term: "React" }, { term: "nodejs" }], 2);
    expect(s.keywords.find((k) => k.term === "Node.js")).toMatchObject({ found: true });
    expect(s.keywords.find((k) => k.term === "Node.js")!.where).toEqual(expect.arrayContaining(["summary", "skills", "experience"]));
    expect(s.keywords.find((k) => k.term === "nodejs")!.found).toBe(true); // "Node.js" counts for "nodejs"
    expect(s.missing).toEqual(["AWS"]);
    expect(s.parts).toMatchObject({ formatting: 30, summary: 20 });
    expect(s.parts.keywords).toBe(Math.round(30 * (2 + 2 + 1 + 1) / (2 + 2 + 2 + 1 + 1)));
    expect(s.issues.join(" ")).toMatch(/Critical keywords missing: AWS/);
    expect(s.score).toBe(s.parts.formatting + s.parts.keywords + s.parts.evidence + s.parts.summary);
    expect(getCvScore(db, doc.id)?.score).toBe(s.score); // saved for the dashboard
    expect(createHumanApi(db).getCvScore(doc.id)?.parts).toEqual(s.parts);
  });

  it("flags a missing summary and headline, too many pages, and a CV that uses only one project", () => {
    const { db, acme, p1, a1, b1, job } = setup();
    const agent = createAgentApi(db);
    const plan = { experience: [{ entryId: acme, bullets: [a1] }], projects: [{ entryId: p1, bullets: [b1] }] };
    const { blocks } = prepareCv(db, plan, job);
    const doc = saveDocument(db, { jobId: job, kind: "cv", path: "documents/x.pdf", blocks, plan }, "agent");
    const s = agent.scoreCv(doc.id, [{ term: "Node.js" }, { term: "Go" }, { term: "Rust" }], 3);
    expect(s.parts.formatting).toBe(20);
    expect(s.issues.join(" | ")).toMatch(/3 pages/);
    expect(s.issues.join(" | ")).toMatch(/no summary/i);
    expect(s.issues.join(" | ")).toMatch(/no headline/i);
    expect(s.issues.join(" | ")).toMatch(/Only 1 of your 2 projects/);
    expect(throws(() => agent.scoreCv(doc.id, [], 1))).toMatch(/keywords/);
  });
});
