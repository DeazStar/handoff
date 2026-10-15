import { describe, expect, it } from "vitest";
import {
  getPreferences as getPreferencesFor, addEntry, addFact, coverMode, createAgentApi, createHumanApi, getEmail, getCoverMaterial, openDb, prepareCover, saveDocument, setPreferences, setProfile,
  type CoverPlan,
} from "../src/index.js";

const H = "human" as const;
const throws = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as Error).message; } return ""; };
const prefs = (over: object = {}) => ({ roles: [], seniority: [], locations: [], remotePolicy: "any" as const, industries: [], exclusions: [], dailyApplicationLimit: 5, dailyDiscoveryLimit: 5, searchAnySite: true, ...over });

const WORDS = (n: number) => Array.from({ length: Math.ceil(n / 10) }, () => "word ".repeat(9) + "end.").join(" ");
const para = (text: string, factIds: number[] = []) => ({ text, factIds });

function setup() {
  const db = openDb(":memory:");
  setProfile(db, { fullName: "Ada Lovelace", email: "ada@example.com", phone: "0911", location: "Lisbon, Portugal", links: ["https://ada.dev"], languages: [] }, H);
  setPreferences(db, prefs(), H);
  const agent = createAgentApi(db);
  const co = agent.upsertCompany({ name: "Acme", domain: "acme.example" });
  const other = agent.upsertCompany({ name: "Other", domain: "other.example" });
  const jobId = agent.addCandidateJob({ title: "Backend Engineer", url: "https://acme.example/j/1", canonicalUrl: "https://acme.example/j/1", companyId: co }).id;
  const fact = addFact(db, { kind: "experience", text: "Built a payments API serving 50000 users" }, H);
  const contact = { id: agent.addContact({ companyId: co, email: "jane@acme.example", name: "Jane Doe", role: "Head of Engineering", sourceUrl: "https://acme.example/team" }) };
  return { db, agent, human: createHumanApi(db), co, other, jobId, fact, contact };
}

// A letter that follows the rules: 185 words, four paragraphs, the role named once, each thing said once.
const body = (fact: number): CoverPlan => ({
  paragraphs: [
    para("I'm applying for the Backend Engineer role at Acme. I'm a software engineer who designs and runs payment services, and I built a payments API serving 50000 users. I own what I build from design through to production support, including the late night incidents.", [fact]),
    para('I design the services behind a product and keep them reliable. I write down decisions, keep the systems simple, and finish what I start, so the next engineer can pick the work up quickly. When a payment fails late at night, I want someone to find the cause in minutes and not in days. I also keep a short list of what could go wrong and how I would notice.', []),
    para('I like small teams where one engineer can see a change from the first sketch to the customer using it. That is how I have worked so far, and it is how I plan to keep working. I am happy to share examples of my work and to explain the choices I made in them.', []),
    para('Happy to talk if it looks like a fit. Thank you for your time and consideration.', []),
  ],
});

describe("prepareCover", () => {
  it("builds the letter, with the greeting and sign-off added by the server", () => {
    const s = setup();
    const r = prepareCover(s.db, body(s.fact), s.jobId);
    expect(r.cover.greeting).toBe("Dear Hiring Manager,");
    expect(r.cover.recipient).toBe("Hiring Manager");
    expect(r.cover.signature).toBe("Ada Lovelace");
    expect(r.cover.subject).toBe("Application: Backend Engineer");
    expect(r.cover.company).toBe("Acme");
    expect(r.words).toBeGreaterThanOrEqual(180);
    expect(r.blocks[0]).toMatchObject({ text: "Dear Hiring Manager,", kind: "boilerplate" });
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
    expect(bad(1, body(s.fact).paragraphs[1]!.text + " I handle 7 incidents a week.", [])).toMatch(/boilerplate must not contain numbers/);
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
    const open = "I'm applying for the Backend Engineer role at Acme. ";
    expect(throws(() => prepareCover(s.db, { paragraphs: [para("One only.", [s.fact])] }, s.jobId))).toMatch(/3 to 4 paragraphs/);
    expect(throws(() => prepareCover(s.db, { paragraphs: [para(open + "Short.", [s.fact]), para("Short two.", []), para("Short three.", [])] }, s.jobId))).toMatch(/at least 180/);
    const long = { paragraphs: Array.from({ length: 4 }, (_, i) => para((i === 0 ? open : "") + WORDS(100), i === 0 ? [s.fact] : [])) };
    expect(throws(() => prepareCover(s.db, long, s.jobId))).toMatch(/the limit is 300/);
    expect(throws(() => prepareCover(s.db, { paragraphs: [para("x".repeat(901), [s.fact]), para("y", []), para("z", [])] }, s.jobId))).toMatch(/901 characters/);
  });

  it("refuses a letter that repeats the posting, names an employer twice, forces a bonus, or has too many numbers", () => {
    const s = setup();
    addEntry(s.db, { kind: "work", title: "Engineer", organization: "Globex", startDate: "2022-01", isCurrent: true }, H);
    const swap = (idx: number, text: string, facts: number[] = []) => {
      const p = body(s.fact);
      p.paragraphs[idx] = para(text, facts);
      return throws(() => prepareCover(s.db, p, s.jobId));
    };
    expect(swap(1, "The posting describes a distributed team where early engineers decide across the stack. I keep systems simple.")).toMatch(/repeats the posting back/);
    expect(swap(1, "You are building a tool for release teams. I keep systems simple.")).toMatch(/repeats the posting back/);
    expect(swap(1, "Mobile experience is a bonus for you. I keep systems simple.")).toMatch(/wish list/);
    expect(swap(1, body(s.fact).paragraphs[1]!.text + " At Globex I run services.")).not.toMatch(/Globex is named/);
    const twice = body(s.fact);
    twice.paragraphs[1] = para("At Globex I run services and keep them reliable for the team and customers every day.", []);
    twice.paragraphs[2] = para("Also at Globex I write down decisions and keep the systems simple for the next engineer.", []);
    expect(throws(() => prepareCover(s.db, twice, s.jobId))).toMatch(/Globex is named in paragraphs 2 and 3/);
    expect(swap(0, body(s.fact).paragraphs[0]!.text.replace("I'm applying for the Backend Engineer role at Acme.", "Backend platforms matter."), [s.fact])).toMatch(/must start "I'm applying for/);
    const many = body(s.fact);
    many.paragraphs[2] = para(many.paragraphs[2]!.text + " It cut 40 steps to 3 and saved 12 hours.", []);
    expect(throws(() => prepareCover(s.db, many, s.jobId))).toMatch(/at most 2/);
  });

  it("allows the years of experience the roles add up to, and no more", () => {
    const s = setup();
    addEntry(s.db, { kind: "work", title: "Engineer", organization: "Globex", startDate: "2021-01", isCurrent: true }, H);
    const withYears = (n: number) => {
      const p = body(s.fact);
      p.paragraphs[0] = para(p.paragraphs[0]!.text.replace("I'm a software engineer", `I'm a software engineer with ${n}+ years`), [s.fact]);
      return p;
    };
    expect(() => prepareCover(s.db, withYears(2), s.jobId)).not.toThrow();
    expect(throws(() => prepareCover(s.db, withYears(30), s.jobId))).toMatch(/"30\+ years" is more than/);
  });

  it("needs an email and a city in the profile for the sender block", () => {
    const s = setup();
    s.db.prepare("UPDATE profile SET location = NULL").run();
    expect(throws(() => prepareCover(s.db, body(s.fact), s.jobId))).toMatch(/Add your city/);
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
    const { emailId } = s.agent.draftEmail({ jobId: s.jobId, contactId: s.contact.id, blocks: [{ text: "Dear Jane,", factIds: [], kind: "boilerplate" }, { text: "I'm applying for the Backend Engineer role at Acme. I built a payments API serving 50000 users; my CV and cover letter are attached.", factIds: [s.fact] }, { text: "Best regards,", factIds: [], kind: "boilerplate" }] });
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
