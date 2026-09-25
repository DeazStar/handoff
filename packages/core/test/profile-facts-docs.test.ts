import { describe, expect, it } from "vitest";
import {
  ProvenanceError, addCandidateJob, addFact, checkProvenance, createAgentApi, createHumanApi,
  deleteFact, getPreferences, getProfile, openDb, saveDocument, setPreferences, setProfile,
} from "../src/index.js";

const prefs = {
  roles: ["Backend Engineer"], seniority: ["mid"], locations: ["Addis Ababa"], remotePolicy: "any" as const,
  industries: [], exclusions: [], salaryFloor: 1000, salaryTarget: 1500, salaryCeiling: 2000,
  currency: "USD", dailyApplicationLimit: 5, dailyDiscoveryLimit: 10, searchAnySite: true, countryPriority: [], bccSelf: true, consentDefault: "none" as const, priorityMode: "remote_first" as const, coverLetters: "auto" as const, cookieBanners: "accept" as const, autoMarkReplied: true, followUpDays: 7, maxFollowUps: 1, noResponseDays: 21, replySnippetDays: 90, replyCheckMinutes: 0, researchMinScore: 7, researchScope: "all" as const, batchSize: 10, employmentPriority: [],
};

describe("profile and preferences", () => {
  it("round-trips and updates in place", () => {
    const db = openDb(":memory:");
    expect(getProfile(db)).toBeNull();
    setProfile(db, { fullName: "Ada", links: ["https://x.dev"], languages: ["English"] }, "human");
    setProfile(db, { fullName: "Ada L", links: [], languages: [] }, "human");
    expect(getProfile(db)?.fullName).toBe("Ada L");
    setPreferences(db, prefs, "human");
    expect(getPreferences(db)).toEqual(prefs);
  });

  it("validates salary ordering and currency", () => {
    const db = openDb(":memory:");
    expect(() => setPreferences(db, { ...prefs, salaryFloor: 3000 }, "human")).toThrow(/floor <= target/);
    expect(() => setPreferences(db, { ...prefs, currency: undefined }, "human")).toThrow(/currency/);
  });

  it("agent cannot write the user's truth", () => {
    const db = openDb(":memory:");
    expect(() => setProfile(db, { fullName: "X", links: [], languages: [] }, "agent")).toThrow(/Only the user/);
    expect(() => addFact(db, { kind: "skill", text: "Rust" }, "agent")).toThrow(/Only the user/);
    const agent = createAgentApi(db);
    expect("addFact" in agent).toBe(false);
    expect("setPreferences" in agent).toBe(false);
  });
});

describe("document provenance", () => {
  const setup = () => {
    const db = openDb(":memory:");
    const a = addFact(db, { kind: "experience", text: "Built a payments API serving 50000 users", dateRange: "2022-2024" }, "human");
    const b = addFact(db, { kind: "skill", text: "TypeScript" }, "human");
    return { db, a, b };
  };

  it("accepts claims that cite facts and match their numbers", () => {
    const { db, a, b } = setup();
    const r = saveDocument(db, {
      jobId: null, kind: "cv", path: "cv.pdf",
      blocks: [
        { text: "Dear hiring team,", factIds: [], kind: "boilerplate" },
        { text: "Built a payments API for 50000 users in TypeScript.", factIds: [a, b] },
      ],
    }, "agent");
    expect(r.version).toBe(1);
    expect(saveDocument(db, { jobId: null, kind: "cv", path: "cv2.pdf", blocks: [{ text: "TypeScript", factIds: [b] }] }, "agent").version).toBe(2);
  });

  it("rejects uncited claims, unknown facts and invented numbers", () => {
    const { db, a } = setup();
    const problems = checkProvenance(db, [
      { text: "Led a team of ten.", factIds: [] },
      { text: "Knows Go.", factIds: [999] },
      { text: "Built a payments API serving 90000 users", factIds: [a] },
    ]);
    expect(problems).toHaveLength(3);
    expect(problems[2]).toMatch(/90000/);
    expect(() => saveDocument(db, { jobId: null, kind: "cv", path: "x", blocks: [{ text: "Led a team", factIds: [] }] }, "agent")).toThrow(ProvenanceError);
  });

  it("does not let a claim hide as boilerplate", () => {
    const { db } = setup();
    expect(checkProvenance(db, [{ text: "I doubled revenue by 200%", factIds: [], kind: "boilerplate" }])).toHaveLength(1);
  });

  it("blocks deleting a cited fact but allows an unused one", () => {
    const { db, a, b } = setup();
    saveDocument(db, { jobId: null, kind: "cv", path: "cv.pdf", blocks: [{ text: "TypeScript", factIds: [b] }] }, "agent");
    expect(() => deleteFact(db, b, "human")).toThrow(/cited by/);
    deleteFact(db, a, "human");
  });

  it("works through the agent and human APIs", () => {
    const db = openDb(":memory:");
    const human = createHumanApi(db);
    const agent = createAgentApi(db);
    const id = human.addFact({ kind: "skill", text: "SQL" });
    expect(agent.listFacts(null)).toHaveLength(1);
    const { id: jobId } = addCandidateJob(db, { title: "t", url: "https://a.io/1", canonicalUrl: "https://a.io/1" });
    expect(agent.saveDocument({ jobId, kind: "email", path: "e.txt", blocks: [{ text: "SQL", factIds: [id] }] }).version).toBe(1);
  });
});
