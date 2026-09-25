import { describe, expect, it } from "vitest";
import {
  getPreferences as getPreferencesFor, addFact, coverMode, createAgentApi, createHumanApi, getEmail, getCoverMaterial, openDb, prepareCover, saveDocument, setPreferences, setProfile,
  type CoverPlan,
} from "../src/index.js";

const H = "human" as const;
const throws = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as Error).message; } return ""; };
const prefs = (over: object = {}) => ({ roles: [], seniority: [], locations: [], remotePolicy: "any" as const, industries: [], exclusions: [], dailyApplicationLimit: 5, dailyDiscoveryLimit: 5, searchAnySite: true, ...over });

const WORDS = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`.replace(/\d/g, "x")).join(" ");
const para = (text: string, factIds: number[] = []) => ({ text, factIds });

function setup() {
  const db = openDb(":memory:");
  setProfile(db, { fullName: "Ada Lovelace", email: "ada@example.com", phone: "0911", location: "Addis Ababa, Ethiopia", links: ["https://ada.dev"], languages: [] }, H);
  setPreferences(db, prefs(), H);
  const agent = createAgentApi(db);
  const co = agent.upsertCompany({ name: "Acme", domain: "acme.example" });
  const other = agent.upsertCompany({ name: "Other", domain: "other.example" });
  const jobId = agent.addCandidateJob({ title: "Backend Engineer", url: "https://acme.example/j/1", canonicalUrl: "https://acme.example/j/1", companyId: co }).id;
  const fact = addFact(db, { kind: "experience", text: "Built a payments API serving 50000 users" }, H);
  const contact = { id: agent.addContact({ companyId: co, email: "jane@acme.example", name: "Jane Doe", role: "Head of Engineering", sourceUrl: "https://acme.example/team" }) };
  return { db, agent, human: createHumanApi(db), co, other, jobId, fact, contact };
}

// About 150 words of plain, plausible text, split in two paragraphs.
const body = (fact: number): CoverPlan => ({
  paragraphs: [
    para("I am writing about the Backend Engineer role. Your posting asks for someone who can design and run payment services, and that is the work I have done for most of my career. I built a payments API serving 50000 users, and I own what I build from design through to production support, including the late night incidents that come with it.", [fact]),
    para("What draws me to Acme is the focus on reliable infrastructure. I like small teams where one engineer can see a change from the first sketch to the customer using it, and I would bring that habit of finishing things, writing down decisions and keeping systems simple enough that the next person can understand them quickly.", []),
    para("I would welcome the chance to talk about how I could help your team. Thank you for your time and for considering my application.", []),
  ],
});

describe("prepareCover", () => {
  it("builds the letter, with the greeting and sign-off added by the server", () => {
    const s = setup();
    const r = prepareCover(s.db, body(s.fact), s.jobId);
    expect(r.cover.greeting).toBe("Dear Hiring Team,");
    expect(r.cover.recipient).toBe("Hiring team");
    expect(r.cover.signature).toBe("Ada Lovelace");
    expect(r.cover.subject).toBe("Application: Backend Engineer");
    expect(r.cover.company).toBe("Acme");
    expect(r.words).toBeGreaterThanOrEqual(120);
    expect(r.blocks[0]).toMatchObject({ text: "Dear Hiring Team,", kind: "boilerplate" });
    expect(r.blocks.at(-1)).toMatchObject({ text: "Ada Lovelace", kind: "boilerplate" });
    expect(r.factIds).toEqual([s.fact]);
  });

  it("addresses a named contact of the same company, and refuses another company's", () => {
    const s = setup();
    const r = prepareCover(s.db, body(s.fact), s.jobId, s.contact.id);
    expect(r.cover.greeting).toBe("Dear Jane,");
    expect(r.cover.recipient).toBe("Jane Doe, Head of Engineering");
    const foreign = s.agent.addContact({ companyId: s.other, email: "x@other.example", name: "Xi Wu", sourceUrl: "https://other.example/team" });
    expect(throws(() => prepareCover(s.db, body(s.fact), s.jobId, foreign))).toMatch(/different company/);
    expect(throws(() => prepareCover(s.db, body(s.fact), s.jobId, 9999))).toMatch(/not found/);
  });

  it("refuses an invented number, boilerplate with numbers, and a claim with no fact", () => {
    const s = setup();
    const bad = (idx: number, text: string, facts: number[]) => {
      const p = body(s.fact);
      p.paragraphs[idx] = para(text, facts);
      return throws(() => prepareCover(s.db, p, s.jobId));
    };
    expect(bad(0, body(s.fact).paragraphs[0]!.text.replace("50000", "90000"), [s.fact])).toMatch(/"90000" does not appear/);
    expect(bad(1, body(s.fact).paragraphs[1]!.text + " I have 10 years of experience.", [])).toMatch(/boilerplate must not contain numbers/);
    expect(bad(0, body(s.fact).paragraphs[0]!.text, [9999])).toMatch(/unknown fact/);
  });

  it("needs at least one cited paragraph", () => {
    const s = setup();
    const p = body(s.fact);
    p.paragraphs[0] = para(p.paragraphs[0]!.text, []);
    expect(throws(() => prepareCover(s.db, p, s.jobId))).toMatch(/must cite the facts/);
  });

  it("holds the paragraph count and the word limits", () => {
    const s = setup();
    expect(throws(() => prepareCover(s.db, { paragraphs: [para("One only.", [s.fact])] }, s.jobId))).toMatch(/2 to 4 paragraphs/);
    expect(throws(() => prepareCover(s.db, { paragraphs: [para("Short one.", [s.fact]), para("Short two.", [])] }, s.jobId))).toMatch(/at least 120/);
    const long = { paragraphs: Array.from({ length: 4 }, (_, i) => para(WORDS(100), i === 0 ? [s.fact] : [])) };
    expect(throws(() => prepareCover(s.db, long, s.jobId))).toMatch(/the limit is 380/);
    expect(throws(() => prepareCover(s.db, { paragraphs: [para("x".repeat(901), [s.fact]), para("y", [])] }, s.jobId))).toMatch(/901 characters/);
  });

  it("needs the job and a profile", () => {
    const s = setup();
    expect(throws(() => prepareCover(s.db, body(s.fact), 9999))).toMatch(/not found/);
    const db = openDb(":memory:");
    const a = createAgentApi(db);
    const j = a.addCandidateJob({ title: "E", url: "https://a.io/1", canonicalUrl: "https://a.io/1" }).id;
    expect(throws(() => prepareCover(db, body(1), j))).toMatch(/no name yet/);
  });
});

describe("cover letter settings and material", () => {
  it("defaults to auto and can be turned off, with guidance", () => {
    const s = setup();
    expect(coverMode(s.db)).toBe("auto");
    setPreferences(s.db, prefs({ coverLetters: "off", coverGuidance: "Warm but direct" }), H);
    expect(coverMode(s.db)).toBe("off");
    expect(getCoverMaterial(s.db, s.jobId)).toMatchObject({ mode: "off", guidance: "Warm but direct" });
    expect(throws(() => setPreferences(s.db, prefs({ coverLetters: "sometimes" as never }), H))).toMatch(/auto or off/);
    expect(throws(() => setPreferences(s.db, prefs({ coverGuidance: "x".repeat(1001) }), H))).toMatch(/1000/);
  });

  it("lists the company's named contacts and the latest letter", () => {
    const s = setup();
    const m = getCoverMaterial(s.db, s.jobId);
    expect(m.namedContacts.map((c) => c.name)).toEqual(["Jane Doe"]);
    expect(m.existing).toBeUndefined();
    const r = prepareCover(s.db, body(s.fact), s.jobId);
    const saved = saveDocument(s.db, { jobId: s.jobId, kind: "cover", path: "documents/c.pdf", blocks: r.blocks, plan: body(s.fact) }, "agent");
    expect(getCoverMaterial(s.db, s.jobId).existing).toEqual({ documentId: saved.id, version: saved.version });
  });
});

describe("the cover letter goes with the email", () => {
  it("is attached to a draft when one exists", () => {
    const s = setup();
    s.agent.setRoute(s.jobId, "email");
    s.agent.recordVerification(s.jobId, { result: "live" }); s.agent.setMatch(s.jobId, 8, "fits");
    saveDocument(s.db, { jobId: s.jobId, kind: "cv", path: "documents/cv.pdf", blocks: [{ text: "Built a payments API serving 50000 users", factIds: [s.fact] }] }, "agent");
    const r = prepareCover(s.db, body(s.fact), s.jobId);
    const cover = saveDocument(s.db, { jobId: s.jobId, kind: "cover", path: "documents/c.pdf", blocks: r.blocks }, "agent");
    s.agent.transitionJob(s.jobId, "materials_ready");
    const { emailId } = s.agent.draftEmail({ jobId: s.jobId, contactId: s.contact.id, blocks: [{ text: "Dear Jane,", factIds: [], kind: "boilerplate" }, { text: "I built a payments API serving 50000 users; my CV and cover letter are attached.", factIds: [s.fact] }, { text: "Best regards,", factIds: [], kind: "boilerplate" }] });
    expect(getEmail(s.db, emailId)!.coverAttachment).toEqual({ documentId: cover.id, version: cover.version });
  });
});

describe("a cover letter on a form", () => {
  function formSetup() {
    const s = setup();
    s.agent.recordVerification(s.jobId, { result: "live" }); s.agent.setMatch(s.jobId, 8, "fits"); s.agent.setRoute(s.jobId, "form");
    saveDocument(s.db, { jobId: s.jobId, kind: "cv", path: "documents/cv.pdf", blocks: [{ text: "Built a payments API serving 50000 users", factIds: [s.fact] }] }, "agent");
    const r = prepareCover(s.db, body(s.fact), s.jobId);
    const cover = saveDocument(s.db, { jobId: s.jobId, kind: "cover", path: "documents/c.pdf", blocks: r.blocks }, "agent");
    s.agent.transitionJob(s.jobId, "materials_ready");
    const prepare = (answers: object[]) => s.agent.prepareApplication({ jobId: s.jobId, formUrl: "https://acme.example/apply", answers: answers as never, leftBlank: [] });
    return { ...s, cover, prepare, text: r.blocks.map((b) => b.text).join("\n\n") };
  }
  it("records an uploaded letter and a pasted one that matches the saved text", () => {
    const f = formSetup();
    f.prepare([
      { question: "Cover letter (upload)", answer: "uploaded Ada-Lovelace-Cover-Letter.pdf", kind: "cover_letter", documentId: f.cover.id },
      { question: "Cover letter (text)", answer: f.text, kind: "cover_letter", documentId: f.cover.id },
    ]);
    expect(f.agent.getApplication(f.jobId)!.answers.map((a) => a.check)).toEqual(["verified", "verified"]);
  });
  it("flags pasted text that is not the saved letter, and refuses a letter that is not this job's", () => {
    const f = formSetup();
    expect(throws(() => f.prepare([{ question: "Cover letter", answer: "uploaded x.pdf", kind: "cover_letter", documentId: 9999 }]))).toMatch(/documentId/);
    expect(throws(() => f.prepare([{ question: "Cover letter", answer: "uploaded x.pdf", kind: "cover_letter" }]))).toMatch(/documentId/);
    f.prepare([{ question: "Cover letter", answer: "Dear team, hire me please.", kind: "cover_letter", documentId: f.cover.id }]);
    expect(f.agent.getApplication(f.jobId)!.answers[0]).toMatchObject({ check: "differs", checkNote: expect.stringMatching(/not the saved cover letter/) });
  });
});

describe("cookie banner setting", () => {
  it("defaults to accepting, can be set to necessary only, and refuses anything else", () => {
    const s = setup();
    expect(getPreferencesFor(s.db)?.cookieBanners).toBe("accept");
    setPreferences(s.db, prefs({ cookieBanners: "necessary" }), H);
    expect(getPreferencesFor(s.db)?.cookieBanners).toBe("necessary");
    expect(throws(() => setPreferences(s.db, prefs({ cookieBanners: "everything" as never }), H))).toMatch(/accept or necessary/);
  });
});
