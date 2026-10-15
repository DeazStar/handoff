import { describe, expect, it } from "vitest";
import { createAgentApi, levelFit, normalizeSeniority, openDb, priorityScore, setPreferences, SENIORITY_LEVELS } from "../src/index.js";

const H = "human" as const;
const throws = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as Error).message; } return ""; };
const prefs = (over: object = {}) => ({ roles: [], seniority: [], locations: [], remotePolicy: "any" as const, industries: [], exclusions: [], dailyApplicationLimit: 5, dailyDiscoveryLimit: 5, searchAnySite: true, ...over });

describe("levels", () => {
  it("are six, from least to most senior", () => {
    expect(SENIORITY_LEVELS).toEqual(["intern", "junior", "mid", "senior", "lead", "staff_plus"]);
  });
  it("understand the words people type", () => {
    expect(normalizeSeniority("Senior")).toBe("senior");
    expect(normalizeSeniority(" MID ")).toBe("mid");
    expect(normalizeSeniority("middle")).toBe("mid");
    expect(normalizeSeniority("mid-level")).toBe("mid");
    expect(normalizeSeniority("entry level")).toBe("junior");
    expect(normalizeSeniority("Staff+")).toBe("staff_plus");
    expect(normalizeSeniority("principal")).toBe("staff_plus");
    expect(normalizeSeniority("Sr")).toBe("senior");
    expect(normalizeSeniority("minor")).toBeUndefined();
    expect(normalizeSeniority("")).toBeUndefined();
  });
  it("say how a job's level sits against the levels wanted", () => {
    expect(levelFit("senior", ["mid", "senior"])).toBe("match");
    expect(levelFit("lead", ["mid", "senior"])).toBe("stretch");
    expect(levelFit("junior", ["mid", "senior"])).toBe("stretch");
    expect(levelFit("staff_plus", ["junior", "mid"])).toBe("mismatch");
    expect(levelFit("intern", ["senior"])).toBe("mismatch");
    expect(levelFit(undefined, ["senior"])).toBeUndefined(); // the posting's level is not known
    expect(levelFit("senior", [])).toBeUndefined(); // the user wants any level
    expect(levelFit("senior", ["middle"])).toBe("stretch"); // old words still count
  });
  it("lower the rank of a job that does not fit, without hiding it", () => {
    const base = priorityScore(6, undefined, "unknown", "balanced");
    expect(priorityScore(6, undefined, "unknown", "balanced", "match")).toBe(base);
    expect(priorityScore(6, undefined, "unknown", "balanced", "stretch")).toBe(base - 1);
    expect(priorityScore(6, undefined, "unknown", "balanced", "mismatch")).toBe(base - 3);
  });
});

describe("the levels setting", () => {
  it("accepts the usual words, saves the six names, and refuses anything else with the choices", () => {
    const db = openDb(":memory:");
    setPreferences(db, prefs({ seniority: ["Junior", "middle", "SENIOR", "mid"] }), H);
    expect(createAgentApi(db).getPreferences()!.seniority).toEqual(["junior", "mid", "senior"]);
    const msg = throws(() => setPreferences(db, prefs({ seniority: ["minor"] }), H));
    expect(msg).toMatch(/"minor" is not a level/);
    expect(msg).toMatch(/Intern, Junior, Mid, Senior, Lead, Staff and above/);
    setPreferences(db, prefs({ seniority: [] }), H);
    expect(createAgentApi(db).getPreferences()!.seniority).toEqual([]);
  });
});

describe("a job's level", () => {
  function job(db: ReturnType<typeof openDb>, n: number, score: number, seniority?: string) {
    const agent = createAgentApi(db);
    const url = `https://acme.example/j/${n}`;
    const id = agent.addCandidateJob({ title: `Job ${n}`, url, canonicalUrl: url }).id;
    agent.recordVerification(id, { result: "live" });
    agent.setMatch(id, score, "fits", { seniority: seniority as never });
    return id;
  }
  it("is recorded with the match, shown as a fit, and lowers the rank of a job that does not fit", () => {
    const db = openDb(":memory:");
    setPreferences(db, prefs({ seniority: ["mid", "senior"] }), H);
    const fits = job(db, 1, 6, "senior");
    const stretch = job(db, 2, 6, "lead");
    const off = job(db, 3, 6, "staff_plus");
    const unknown = job(db, 4, 6);
    const rows = createAgentApi(db).listJobs(undefined, "priority");
    const by = (id: number) => rows.find((r) => r.id === id)!;
    expect([by(fits).levelFit, by(stretch).levelFit, by(off).levelFit, by(unknown).levelFit]).toEqual(["match", "stretch", "mismatch", undefined]);
    expect(by(fits).seniority).toBe("senior");
    // Best first: the fit and the unknown, then the stretch, then the mismatch. All four are still listed.
    expect(rows.map((r) => r.id).slice(2)).toEqual([stretch, off]);
    expect(rows).toHaveLength(4);
  });
  it("is refused when it is not one of the six", () => {
    const db = openDb(":memory:");
    const agent = createAgentApi(db);
    const id = agent.addCandidateJob({ title: "J", url: "https://a.io/1", canonicalUrl: "https://a.io/1" }).id;
    agent.recordVerification(id, { result: "live" });
    expect(throws(() => agent.setMatch(id, 5, "x", { seniority: "minor" as never }))).toMatch(/seniority must be one of/);
  });
});

describe("how the agent asks the user for an answer", () => {
  const get = (db: ReturnType<typeof openDb>) => createAgentApi(db).getPreferences()!;
  it("defaults to batch with no overrides, and keeps a choice and its overrides", () => {
    const db = openDb(":memory:");
    setPreferences(db, prefs(), H);
    expect(get(db)).toMatchObject({ questionMode: "batch", questionOverrides: {} });
    setPreferences(db, prefs({ questionMode: "chat", questionOverrides: { skill_levels: "never", sensitive: "chat", preferences: "cards" } }), H);
    expect(get(db)).toMatchObject({ questionMode: "chat", questionOverrides: { skill_levels: "never", sensitive: "chat", preferences: "cards" } });
  });
  it("refuses a mode or a kind of question it does not know", () => {
    const db = openDb(":memory:");
    expect(throws(() => setPreferences(db, prefs({ questionMode: "whenever" as never }), H))).toMatch(/batch, chat or cards/);
    expect(throws(() => setPreferences(db, prefs({ questionOverrides: { gossip: "chat" } as never }), H))).toMatch(/not a kind of question/);
    expect(throws(() => setPreferences(db, prefs({ questionOverrides: { skill_levels: "sometimes" } as never }), H))).toMatch(/batch, chat, cards or never/);
  });
});
