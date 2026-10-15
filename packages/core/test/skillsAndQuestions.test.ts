import { describe, expect, it } from "vitest";
import { askUser, createAgentApi, createHumanApi, getCvMaterial, openDb, parseSkillItem, setPreferences, setSkillGroup, setStandardAnswer } from "../src/index.js";

const H = "human" as const;
const throws = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as Error).message; } return ""; };
const prefs = (over: object = {}) => ({ roles: [], seniority: [], locations: [], remotePolicy: "any" as const, industries: [], exclusions: [], dailyApplicationLimit: 5, dailyDiscoveryLimit: 5, searchAnySite: true, ...over });

describe("skill levels", () => {
  it("reads a level after a colon, and leaves everything else as the skill's name", () => {
    expect(parseSkillItem("Python:advanced")).toEqual({ text: "Python", level: "advanced" });
    expect(parseSkillItem(" Node.js : Expert ")).toEqual({ text: "Node.js", level: "expert" });
    expect(parseSkillItem("C#")).toEqual({ text: "C#" });
    expect(parseSkillItem("Rust: very good")).toEqual({ text: "Rust: very good" });
    expect(parseSkillItem("Docker:")).toEqual({ text: "Docker:" });
  });

  it("saves levels with the skills, shows them in the material, changes and clears them", () => {
    const db = openDb(":memory:");
    setSkillGroup(db, "Backend", ["Python:advanced", "Node.js", "Docker:intermediate"], H);
    const level = () => Object.fromEntries(getCvMaterial(db, null).skills.flatMap((g) => g.skills.map((s) => [s.text, s.level])));
    expect(level()).toEqual({ Python: "advanced", "Node.js": undefined, Docker: "intermediate" });
    setSkillGroup(db, "Backend", ["Python:expert", "Node.js:beginner", "Docker"], H);
    expect(level()).toEqual({ Python: "expert", "Node.js": "beginner", Docker: undefined });
    expect(getCvMaterial(db, null).skills[0]!.skills).toHaveLength(3); // a changed level is not a new skill
    setSkillGroup(db, "Backend", ["Python"], H);
    expect(level()).toEqual({ Python: undefined });
  });

  it("keeps the CV text of a skill free of its level", () => {
    const db = openDb(":memory:");
    setSkillGroup(db, "Backend", ["Python:advanced"], H);
    expect(getCvMaterial(db, null).skills[0]!.skills[0]!.text).toBe("Python");
  });

  it("has an optional default level that the agent can read, and refuses a made-up one", () => {
    const db = openDb(":memory:");
    expect(getCvMaterial(db, null).defaultSkillLevel).toBeUndefined();
    setPreferences(db, prefs({ defaultSkillLevel: "intermediate" }), H);
    expect(getCvMaterial(db, null).defaultSkillLevel).toBe("intermediate");
    setPreferences(db, prefs(), H);
    expect(getCvMaterial(db, null).defaultSkillLevel).toBeUndefined();
    expect(throws(() => setPreferences(db, prefs({ defaultSkillLevel: "guru" as never }), H))).toMatch(/must be beginner/);
  });
});

describe("asking the user a question", () => {
  const OPTIONS = ["not interested in equity", "some equity at a promising company", "equity is very important"];
  it("queues one card with the options, however often it is asked", () => {
    const db = openDb(":memory:");
    const agent = createAgentApi(db);
    const a = agent.askUser(null, { question: "Equity preference", options: OPTIONS, site: "https://www.workatastartup.com/profile" });
    expect(a.alreadyOpen).toBe(false);
    expect(agent.askUser(null, { question: "equity preference", options: OPTIONS }).alreadyOpen).toBe(true);
    const card = (agent.listOpenActions() as any[]).find((x) => x.kind === "sensitive_question");
    expect(JSON.parse(card.payload)).toMatchObject({ question: "Equity preference", options: OPTIONS, site: "ycombinator.com" });
  });

  it("works for a free answer, and checks what it is given", () => {
    const db = openDb(":memory:");
    const agent = createAgentApi(db);
    expect(agent.askUser(null, { question: "Why did you leave your last job?" }).alreadyOpen).toBe(false);
    expect(throws(() => askUser(db, null, { question: " " }, "agent"))).toMatch(/needs text/);
    expect(throws(() => askUser(db, null, { question: "x".repeat(201) }, "agent"))).toMatch(/up to 200/);
    expect(throws(() => askUser(db, null, { question: "Q", options: ["only one"] }, "agent"))).toMatch(/2 to 10 options/);
    expect(throws(() => askUser(db, null, { question: "Q2", options: ["A", "a"] }, "agent"))).toMatch(/must differ/);
    expect(throws(() => askUser(db, null, { question: "Q3", options: Array.from({ length: 11 }, (_, i) => `o${i}`) }, "agent"))).toMatch(/2 to 10 options/);
  });

  it("does not ask again once the user has answered: the answer is a saved standard answer", () => {
    const db = openDb(":memory:");
    const agent = createAgentApi(db);
    setStandardAnswer(db, "Equity preference", "some equity at a promising company", H);
    const msg = throws(() => agent.askUser(null, { question: "equity preference", options: OPTIONS }));
    expect(msg).toMatch(/already answered this: "some equity at a promising company"/);
    expect(createHumanApi(db).listStandardAnswers().map((s) => s.label)).toContain("Equity preference");
  });
});
